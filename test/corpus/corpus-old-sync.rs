/// Writes pending queue items to disk.
///
/// This function handles the low-level I/O:
/// 1. Writes datablocks first (growing downward from end of file)
/// 2. Updates metablocks with datablock positions
/// 3. Writes metablocks (growing upward from header)
/// 4. Updates bloom filter
/// 5. Writes dual headers
/// 6. Calls fdatasync for durability
/// sync_positions_snapshot is mutable because we need to set the datablocks absolute position as we write (only known at write time)
pub(crate) async fn sync(
    log_segment_file: Rc<LogSegmentFile>,
    sync_positions_snapshot: &mut SyncPositionsSnapshot,
    commit_target: CommitTarget,
) -> Result<LogSegmentFileMetadata, ShardFsyncError> {
    let mut log_segment_file_metadata = log_segment_file.metadata.borrow().clone();

    let dma_file_writer = log_segment_file.lock_writer("sync").await
        .map_err(|_| ShardFsyncError::WriteLockTimeout)?;
    let dma_file_writer = dma_file_writer
        .as_ref()
        .ok_or_else(|| ShardFsyncError::ActiveWriteFileUnavailable)?;

    // Write datablocks first so we can get the positions to include into metablocks
    let buffer_size_datablocks: u64 = sync_positions_snapshot.buffer_size_datablocks();
    let alignment = (dma_file_writer.alignment() as u64).max(MIN_WRITE_ALIGNMENT);

    let mut datablocks_absolute_write_positions: Vec<u64> = Vec::with_capacity(sync_positions_snapshot.pending_append_queue.len());
    let mut new_datablocks_position = log_segment_file_metadata.write.datablocks_position;
    let mut datablocks_carry_over: Option<Vec<u8>> = log_segment_file_metadata.datablocks_carry_over.take();

    if buffer_size_datablocks > 0 {
        let write_to_pos = constants::align_up(log_segment_file_metadata.write.datablocks_position, alignment);
        new_datablocks_position = log_segment_file_metadata.write.datablocks_position.saturating_sub(buffer_size_datablocks);
        let write_from_pos = constants::align_down(new_datablocks_position, alignment);
        let aligned_buffer_size_datablocks = write_to_pos.saturating_sub(write_from_pos);

        let front_carry_over = new_datablocks_position.saturating_sub(write_from_pos) as usize;
        let end_carry_over = write_to_pos.saturating_sub(log_segment_file_metadata.write.datablocks_position) as usize;

        let mut buffer_datablocks = dma_file_writer.alloc_dma_buffer(front_carry_over + buffer_size_datablocks as usize + end_carry_over);
        let buffer_datablocks_slice = buffer_datablocks.as_bytes_mut();

        buffer_datablocks_slice.fill(0);

        if end_carry_over > 0 {
            if datablocks_carry_over.is_none() || datablocks_carry_over.as_ref().unwrap().len() != end_carry_over as usize {
                return Err(ShardFsyncError::DatablocksCarryOverBufferNotPresent);
            }
            buffer_datablocks_slice[(aligned_buffer_size_datablocks.saturating_sub(end_carry_over as u64)) as usize..]
                .copy_from_slice(&datablocks_carry_over.as_ref().unwrap());
        }

        let mut position = buffer_size_datablocks as usize;
        for item in &sync_positions_snapshot.pending_append_queue {
            if let Some(datablock_bytes) = &item.datablock_bytes {
                let len = datablock_bytes.len();
                position -= len;
                let start_idx = front_carry_over + position;
                let end_idx = front_carry_over + position + len;

                datablocks_absolute_write_positions.push(new_datablocks_position + position as u64);
                buffer_datablocks_slice[start_idx..end_idx].copy_from_slice(datablock_bytes);
            }
        }

        let datablocks_carry_over_size = constants::align_up(new_datablocks_position, alignment).saturating_sub(new_datablocks_position);
        if datablocks_carry_over_size > 0 {
            datablocks_carry_over =
                Some(buffer_datablocks_slice[front_carry_over..(front_carry_over + datablocks_carry_over_size as usize)].to_vec());
        }

        dma_file_writer
            .write_at(buffer_datablocks, new_datablocks_position.saturating_sub(front_carry_over as u64))
            .await
            .map_err(|e| ShardFsyncError::WriteDatablocksError(e.to_string()))?;
    }

    let content_size_metablocks: u64 = sync_positions_snapshot.buffer_size_metablocks();
    let padded_size_metablocks = constants::align_up(content_size_metablocks, alignment) as usize;
    let mut buffer_metablocks = dma_file_writer.alloc_dma_buffer(padded_size_metablocks);
    let buffer_metablocks_slice = buffer_metablocks.as_bytes_mut();
    let mut position = 0usize;
    let mut index = 0;
    // Within-batch view of each aggregate's latest metablock position, layered over
    // the segment's committed tips, so multiple metablocks for one aggregate in this
    // batch chain to each other. Applied to the live tips only on commit.
    let mut chain_overlay: HashMap<AggregateKey, u64> = HashMap::new();
    for item in &mut sync_positions_snapshot.pending_append_queue {
        if item.datablock_bytes.is_some() && item.datablock.is_some() {
            item.metablock.datablock_position = datablocks_absolute_write_positions[index];
            index += 1;
        }

        log_segment_file_metadata.write.wal_seq = log_segment_file_metadata.write.wal_seq.saturating_add(1);
        item.metablock.wal_seq = log_segment_file_metadata.write.wal_seq;

        // Track the absolute position where this metablock is written
        let metablock_absolute_pos = log_segment_file_metadata.write.metablocks_position + position as u64;
        item.metablock_absolute_pos = metablock_absolute_pos;

        // Update aggregate positions tracking (only if entry exists). SoftDelete must
        // record its position too: the commit path's deleted_positions map reads it,
        // and a delete-only window otherwise leaves the or_insert default (0, 0) —
        // exists() then chases a metablock at log_0/pos_0 and errors.
        let positions_key = match &item.metablock.wal_metablock_type {
            MetablockKind::EventBatchMetadata(event_batch) => Some(&event_batch.aggregate_key),
            MetablockKind::SoftDelete(soft_delete) => Some(&soft_delete.aggregate_key),
            _ => None,
        };
        if let Some(key) = positions_key {
            if let Some(aggregate_positions) = sync_positions_snapshot.aggregate_queue_positions.get_mut(key) {
                aggregate_positions.log_id = log_segment_file_metadata.log_id;
                aggregate_positions.metablock_absolute_pos = metablock_absolute_pos;
                aggregate_positions.wal_seq = item.metablock.wal_seq;
            }
        }

        // Per-aggregate backlink to this aggregate's previous metablock in this segment
        // (0 = none). Excluded from the hash chain, recomputed locally on every node.
        if let Some(key) = chain_aggregate_key(&item.metablock).cloned() {
            let prev = chain_overlay
                .get(&key)
                .copied()
                .or_else(|| log_segment_file.aggregate_chain_tips.borrow().get(&key).copied())
                .unwrap_or(0);
            item.metablock.previous_aggregate_metablock_pos = prev;
            chain_overlay.insert(key, metablock_absolute_pos);
        }

        // Keep the chain - store the previous hash in the next metablock. Done before serialisation!
        item.metablock.previous_tip_hash = log_segment_file_metadata.write.tip_hash;

        // Serialise straight into the DMA buffer. `serialize_versioned_message` writes the CRC,
        // the version and the payload and then zero-fills the rest of the slice it is given, so
        // it leaves no byte of a FIXED_BLOCK_SIZE_BYTES destination untouched
        let metablock_bytes = &mut buffer_metablocks_slice[position..position + FIXED_BLOCK_SIZE_BYTES];
        serialize_versioned_message(&item.metablock, WIRE_VERSION_WAL_METABLOCK, metablock_bytes)
            .map_err(|e| ShardFsyncError::MetablockSerialisationError(e.to_string()))?;

        // Compute hash chain, excluding datablock_position (node-local offset that differs between nodes)
        log_segment_file_metadata.write.tip_hash = compute_entry_hash(&log_segment_file_metadata.write.tip_hash, metablock_bytes);

        position += FIXED_BLOCK_SIZE_BYTES;
    }

    //Write metablocks — position advances by content size, not padded size
    let new_metablocks_position = log_segment_file_metadata.write.metablocks_position + content_size_metablocks;
    dma_file_writer
        .write_at(buffer_metablocks, log_segment_file_metadata.write.metablocks_position)
        .await
        .map_err(|e| ShardFsyncError::WriteMetablocksError(e.to_string()))?;

    // Update bloom filter with aggregate keys and schema keys from this batch
    for item in &sync_positions_snapshot.pending_append_queue {
        match &item.metablock.wal_metablock_type {
            MetablockKind::EventBatchMetadata(event_batch) => {
                log_segment_file_metadata.write.aggregate_key_bloom.borrow_mut().insert(&event_batch.aggregate_key);
                log_segment_file_metadata.write.client_id_bloom.borrow_mut().insert_hash(client_id_bloom_hash(event_batch.client_id));
            }
            MetablockKind::SchemaRegistration(schema_reg) => {
                log_segment_file_metadata.write.aggregate_key_bloom.borrow_mut().insert_hash(schema_reg.schema_key.bloom_hash());
            }
            MetablockKind::SoftDelete(soft_delete) => {
                log_segment_file_metadata.write.aggregate_key_bloom.borrow_mut().insert(&soft_delete.aggregate_key);
            }
            MetablockKind::SoftTrim(soft_trim) => {
                log_segment_file_metadata.write.aggregate_key_bloom.borrow_mut().insert(&soft_trim.aggregate_key);
            }
        }
    }

    // Update positions and carry over
    log_segment_file_metadata.write.metablocks_position = new_metablocks_position;
    log_segment_file_metadata.datablocks_carry_over = datablocks_carry_over;
    log_segment_file_metadata.write.datablocks_position = new_datablocks_position;

    // Full commit: pre-advance read so the persisted header matches the final state
    // rather than lagging by one fsync. Deferred targets persist the current read
    // as-is (a follower's drain may already have advanced it before this fsync).
    if commit_target == CommitTarget::FullCommit {
        log_segment_file_metadata.advance_visible_position();
    }
    let header_end_start_pos = log_segment_file_metadata.file_len.saturating_sub(HEADER_BLOCK_SIZE_BYTES as u64);
    let header = log_segment_file_metadata.to_shard_log_header();
    write_dual_shard_log_header(&dma_file_writer, header_end_start_pos, &header).await
        .map_err(ShardFsyncError::LogSegmentFileHeaderWriteFailure)?;

    dma_file_writer.fdatasync().await
        .map_err(|e| ShardFsyncError::FDataSyncError(e.to_string()))?;

    log_segment_file.note_header_synced(
        log_segment_file_metadata.last_self_acked_wal_seq,
        log_segment_file_metadata.read.as_ref().map_or(0, |r| r.wal_seq),
    );

    Ok(log_segment_file_metadata)
}