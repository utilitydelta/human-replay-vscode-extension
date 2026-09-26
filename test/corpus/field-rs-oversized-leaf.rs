async fn aggregate_exists_and_cache_once(&self, searching_for_aggregate_key: &AggregateKey, cache_path: CachePath) -> Result<bool, ShardCacheLoadError> {
        let load_epoch_at_start = self.shard_mem_cache.borrow().load_epoch();
        // If we are cached already
        if let (true, status) = self.shard_mem_cache.borrow_mut().aggregate_load_status(searching_for_aggregate_key, cache_path) {
            trace!(
                shard_id = self.config.shard_id,
                aggregate_key = %searching_for_aggregate_key,
                ?cache_path,
                found = (status == AggregateStatus::Found),
                "Cache hit — no disk scan needed"
            );
            return Ok(status == AggregateStatus::Found);
        }

        // Take an exclusive lock on this aggregate to deduplicate thundering herd
        let aggregate_lock = self.aggregate_loading.acquire(searching_for_aggregate_key);
        let _ = write_with_timeout(&aggregate_lock, "move_aggregate_to_memcache").await
            .map_err(|_| ShardCacheLoadError::AggregateLoadingLockTimeout)?;

        // We have exclusive access now, check if another concurrent task has already done the work
        if let (true, status) = self.shard_mem_cache.borrow_mut().aggregate_load_status(searching_for_aggregate_key, cache_path) {
            return Ok(status == AggregateStatus::Found);
        }

        // Limit concurrent disk scans across different aggregates (NVMe starvation)
        let sem_wait_start = std::time::Instant::now();
        let _cache_permit = self.cache_load_semaphore.acquire_permit(1).await
            .map_err(|_| ShardCacheLoadError::AggregateLoadingLockTimeout)?;
        metrics::histogram!("celeriant_read_semaphore_wait_seconds", &self.metrics_shard_label)
            .record(sem_wait_start.elapsed().as_secs_f64());

        let (starting_log_id, start_from_postion) = match cache_path {
            CachePath::Read => {
                let read_cursor = self.log_segments_cache.get_latest_read_cursor();
                (read_cursor.log_id, Some(read_cursor.metablocks_position))
            },
            CachePath::Write => (self.log_segments_cache.active_log_id(), None),
        };

        // Begin the search from the active log, moving backwards
        let skipped = Cell::new(false);
        let mut scanner = ReverseMetablockScanner::new(
            &self.log_segments_cache,
            starting_log_id,
            start_from_postion,
            self.config.read_max_chunk_size,
        )
        .with_bloom_filter(searching_for_aggregate_key)
        .with_skip_flag(&skipped);
        if cache_path == CachePath::Write {
            scanner = scanner.with_write_cursor_upper_bound();
        }

        let find_result = scanner
            .scan::<bool, ()>(|log_id, metablock_absolute_pos, metablock_bytes| {
                #[cfg(test)]
                if let Some(hook) = self.aggregate_scan_visit_hook.borrow_mut().take() { hook(self); }
                let mut cache = self.shard_mem_cache.borrow_mut();
                if cache.load_epoch() != load_epoch_at_start { return Ok(Some(false)); }
                let (loaded, status) = cache.aggregate_load_status(searching_for_aggregate_key, cache_path);
                if loaded { return Ok(Some(status == AggregateStatus::Found)); }
                drop(cache);
                // A bloom-skipped newer segment may hold newer blocks for other keys.
                if skipped.get() && metablock_bytes::read_chain_aggregate_key(metablock_bytes).as_ref() != Some(searching_for_aggregate_key) {
                    return Ok(None);
                }
                // Eager snapshots must honor the newest marker for every key;
                // otherwise an unrelated scan can resurrect pre-delete events.
                if metablock_bytes::is_metablock_kind_soft_delete(metablock_bytes) {
                    let key = metablock_bytes::read_soft_delete_aggregate_key(metablock_bytes);
                    let low_priority = key != *searching_for_aggregate_key;
                    if low_priority && self.shard_mem_cache.borrow_mut().is_aggregate_snapshot_full_or_contains(&key, cache_path) {
                        return Ok(None);
                    }
                    let metablock = deserialise_metablock(metablock_bytes)
                        .map_err(|_| ())?;
                    
                    if let MetablockKind::SoftDelete(soft_delete) = metablock.wal_metablock_type {
                        let mut shard_mem_cache = self.shard_mem_cache.borrow_mut();
                        shard_mem_cache.put_aggregate_into_cache_as_deleted(
                            key,
                            log_id,
                            metablock_absolute_pos,
                            soft_delete.event_seq,
                            soft_delete.aggregate_version,
                            soft_delete.allow_recreate,
                            soft_delete.allow_sequence_continuation,
                            cache_path,
                        );
                    }
                    return Ok(if low_priority { None } else { Some(false) });
                }

                if metablock_bytes::is_metablock_kind_soft_trim(metablock_bytes) {
                    let key = metablock_bytes::read_soft_trim_aggregate_key(metablock_bytes);
                    let low_priority = key != *searching_for_aggregate_key;
                    if low_priority && self.shard_mem_cache.borrow_mut().is_aggregate_snapshot_full_or_contains(&key, cache_path) {
                        return Ok(None);
                    }
                    let metablock = deserialise_metablock(metablock_bytes)
                        .map_err(|_| ())?;
                    if let MetablockKind::SoftTrim(soft_trim) = metablock.wal_metablock_type {
                        let snapshot = MemSnapshotAggregate::found(
                            log_id,
                            metablock_absolute_pos,
                            soft_trim.event_seq,
                            soft_trim.aggregate_version,
                            soft_trim.keep_from_aggregate_version,
                        );
                        let mut shard_mem_cache = self.shard_mem_cache.borrow_mut();
                        shard_mem_cache.put_aggregate_snapshot_only(
                            key,
                            snapshot,
                            low_priority,
                            cache_path,
                        );
                    }
                    return Ok(if low_priority { None } else { Some(true) });
                }

                if !metablock_bytes::is_metablock_kind_event_batch_metadata(metablock_bytes) {
                    return Ok(None);
                }

                let current_aggregate_key = metablock_bytes::read_event_batch_aggregate_key(metablock_bytes);
                let low_priority = *searching_for_aggregate_key != current_aggregate_key;

                let mut shard_mem_cache = self.shard_mem_cache.borrow_mut();

                // Not the aggregate we are searching for. Can we eager cache it? If not, skip it.
                if low_priority && shard_mem_cache.is_aggregate_snapshot_full_or_contains(&current_aggregate_key, cache_path) {
                    return Ok(None);
                }

                let min_aggregate_version = metablock_bytes::read_event_batch_min_aggregate_version(metablock_bytes);

                let snapshot = MemSnapshotAggregate::found(
                    log_id,
                    metablock_absolute_pos,
                    metablock_bytes::read_event_batch_max_event_seq(metablock_bytes),
                    metablock_bytes::read_event_batch_aggregate_version(metablock_bytes),
                    min_aggregate_version,
                );

                let client_id = metablock_bytes::read_event_batch_client_id(metablock_bytes);
                let last_client_seq = metablock_bytes::read_event_batch_max_client_seq(metablock_bytes);

                shard_mem_cache.put_aggregate_into_cache(current_aggregate_key, snapshot, client_id, last_client_seq, low_priority, cache_path);

                if low_priority {
                    Ok(None) //Haven't found aggregate yet
                } else {
                    Ok(Some(true)) //Done searching
                }
            })
            .await
            .map_err(ShardCacheLoadError::FileScanningError)?;

        if self.shard_mem_cache.borrow().load_epoch() != load_epoch_at_start { return Ok(false); }
        let (loaded, status) = self.shard_mem_cache.borrow_mut().aggregate_load_status(searching_for_aggregate_key, cache_path);
        if loaded { return Ok(status == AggregateStatus::Found); }
        let found = find_result.unwrap_or(false);
        trace!(
            shard_id = self.config.shard_id,
            aggregate_key = %searching_for_aggregate_key,
            ?cache_path,
            found,
            "Disk scan complete"
        );
        if find_result.is_none() {
            // Never found any metablock for this aggregate
            let mut shard_mem_cache = self.shard_mem_cache.borrow_mut();
            shard_mem_cache.put_aggregate_into_cache_as_not_found(searching_for_aggregate_key.clone(), cache_path);
        }

        return Ok(found);
    }