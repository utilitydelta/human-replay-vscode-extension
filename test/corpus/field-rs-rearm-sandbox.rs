//! What a metablock says, independent of its bytes. `metablock::encode` writes these values and
//! `MetablockView::to_metablock` reads them back; everything on the hot path reads through the view.
use zerocopy::{Immutable, IntoBytes, KnownLayout, TryFromBytes};

use crate::composites::{aggregate_key::AggregateKey, schema_key::SchemaKey};
use crate::primitives::{
    identifier::{ClientId, NodeId, UserId},
    lengths::{CompressedSize, UncompressedSize},
    monotonic_seq::{AggregateSeq, ClientSeq, EventSeq, NodeLeaseEpoch, WalSeq},
    positions::{DatablockDiskStartPos, MetablockDiskStartPos},
    sets::{EntryHashSpace, EventTypeBloomSpace, MinibatchSpace},
    u32_typed::Crc32,
    utc_timestamp::{EventUtcTimestamp, MetablockUtcTimestamp},
};

/// How a datablock's bytes are compressed. A per-block choice the writer makes, not a format, so it is a
/// field rather than part of the metablock type. A reader needs only none or zstd: zstd frames don't need
/// the level to decompress, and the dictionary is pinned per data root and per cluster (v7's
/// `server_meta.toml` sha and `DictHello`). 1 is v7's `CompressionType::ZstdDict` value.
#[derive(TryFromBytes, IntoBytes, KnownLayout, Immutable, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Compression {
    None = 0,
    Zstd = 1,
}

/// Fields every metablock carries, whatever its kind.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MetablockCommon {
    pub wal_seq: WalSeq,
    pub server_timestamp: MetablockUtcTimestamp,
    pub lease_epoch: NodeLeaseEpoch,
    pub node_id: NodeId,
    pub uncompressed_size: UncompressedSize,
    pub compressed_size: CompressedSize,
    pub compression: Compression,
    /// Hash chain over the WAL. The node-local positions below are excluded from it.
    pub previous_tip_hash: EntryHashSpace,
    pub datablock_position: DatablockDiskStartPos,
    /// Backlink to the previous metablock of the same aggregate in this segment. Sentinel = none.
    pub previous_aggregate_metablock_pos: MetablockDiskStartPos,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EventTypes {
    /// More than 4 distinct event types: a bloom over them.
    Bloom(EventTypeBloomSpace),
    /// Up to 4 event type majors, as LE u64 words.
    Direct(EventTypeBloomSpace),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EventBatch {
    pub aggregate_key: AggregateKey,
    pub aggregate_seq: AggregateSeq,
    pub trimmed_below: AggregateSeq,
    pub min_client_seq: ClientSeq,
    pub max_client_seq: ClientSeq,
    pub min_event_timestamp: EventUtcTimestamp,
    pub max_event_timestamp: EventUtcTimestamp,
    /// The batch's event seqs are contiguous: `min_event_seq..=max_event_seq`, one per event.
    pub min_event_seq: EventSeq,
    pub max_event_seq: EventSeq,
    pub client_id: ClientId,
    pub user_id: Option<UserId>,
    pub event_types: EventTypes,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SchemaRegistration {
    pub schema_key: SchemaKey,
    pub client_id: ClientId,
    pub user_id: Option<UserId>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SoftDelete {
    pub aggregate_key: AggregateKey,
    pub allow_recreate: bool,
    pub allow_sequence_continuation: bool,
    pub aggregate_seq: AggregateSeq,
    pub event_seq: EventSeq,
    pub client_id: ClientId,
    pub user_id: Option<UserId>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SoftTrim {
    pub aggregate_key: AggregateKey,
    pub keep_from: AggregateSeq,
    pub aggregate_seq: AggregateSeq,
    pub event_seq: EventSeq,
    pub client_id: ClientId,
    pub user_id: Option<UserId>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MetablockBody {
    EventBatch(EventBatch),
    SchemaRegistration(SchemaRegistration),
    SoftDelete(SoftDelete),
    SoftTrim(SoftTrim),
}

/// Where a metablock's datablock lives. The inline variant holds the minibatch by value on purpose: the
/// owned `Metablock` is a copy for code that outlives the block buffer, and hot paths use the view.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DatablockStorage {
    None,
    /// Small enough to live in the metablock. Event batches only.
    Inline(MinibatchSpace),
    /// In the segment's datablock region at `MetablockCommon::datablock_position`.
    Block { crc32c: Crc32 },
}

/// One metablock, owned. It holds the inline minibatch by value, so it is about a kilobyte: keep it off
/// hot paths and read through `MetablockView` instead.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Metablock {
    pub common: MetablockCommon,
    pub body: MetablockBody,
    pub datablock: DatablockStorage,
}

/// The four kinds. Their numbers are byte 4 of the metablock type word.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum MetablockKind {
    EventBatch = 0,
    SchemaRegistration = 1,
    SoftDelete = 2,
    SoftTrim = 3,
}

impl MetablockBody {
    pub fn kind(&self) -> MetablockKind {
        match self {
            MetablockBody::EventBatch(_) => MetablockKind::EventBatch,
            MetablockBody::SchemaRegistration(_) => MetablockKind::SchemaRegistration,
            MetablockBody::SoftDelete(_) => MetablockKind::SoftDelete,
            MetablockBody::SoftTrim(_) => MetablockKind::SoftTrim,
        }
    }

    /// Aggregate whose backlink chain this metablock sits in. None for schema registrations.
    pub fn chain_aggregate_key(&self) -> Option<AggregateKey> {
        match self {
            MetablockBody::EventBatch(b) => Some(b.aggregate_key),
            MetablockBody::SoftDelete(b) => Some(b.aggregate_key),
            MetablockBody::SoftTrim(b) => Some(b.aggregate_key),
            MetablockBody::SchemaRegistration(_) => None,
        }
    }
}

/// What the reverse scan, the chain walk and recovery read from every block. `metablock::scan` reads
/// these straight from the bytes without validating the rest of the block.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ScanFields {
    pub kind: MetablockKind,
    pub wal_seq: WalSeq,
    pub server_timestamp: MetablockUtcTimestamp,
    pub node_id: NodeId,
    pub compressed_size: CompressedSize,
    pub uncompressed_size: UncompressedSize,
    pub datablock_position: DatablockDiskStartPos,
    pub previous_aggregate_metablock_pos: MetablockDiskStartPos,
    pub chain_aggregate_key: Option<AggregateKey>,
}

impl ScanFields {
    /// The scan fields of an owned metablock, for tests that compare a scan against a decode.
    pub fn of(m: &Metablock) -> Self {
        Self {
            kind: m.body.kind(),
            wal_seq: m.common.wal_seq,
            server_timestamp: m.common.server_timestamp,
            node_id: m.common.node_id,
            compressed_size: m.common.compressed_size,
            uncompressed_size: m.common.uncompressed_size,
            datablock_position: m.common.datablock_position,
            previous_aggregate_metablock_pos: m.common.previous_aggregate_metablock_pos,
            chain_aggregate_key: m.body.chain_aggregate_key(),
        }
    }
}
