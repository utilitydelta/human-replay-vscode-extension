use super::header::{ShardLogHeader, decode_header};
use super::layout::Slot;
use crate::disk::error::FormatError;
use crate::primitives::monotonic_seq::HeaderSeq;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SlotFault {
    Zeroed,
    Format(FormatError),
    Parity { header_seq: HeaderSeq },
    OpenCheck,
    TailCheck,
    Outranked,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SlotScan {
    Fault(SlotFault),
    OpenFailed(ShardLogHeader),
    Untested(ShardLogHeader),
    TailPassed(ShardLogHeader),
    TailFailed(ShardLogHeader),
}

impl SlotScan {
    fn header_seq(self) -> Option<HeaderSeq> {
        match self {
            SlotScan::Fault(_) => None,
            SlotScan::OpenFailed(h) | SlotScan::Untested(h) | SlotScan::TailPassed(h) | SlotScan::TailFailed(h) => Some(h.header_seq),
        }
    }

    fn fault(self) -> SlotFault {
        match self {
            SlotScan::Fault(fault) => fault,
            SlotScan::OpenFailed(_) => SlotFault::OpenCheck,
            SlotScan::TailFailed(_) => SlotFault::TailCheck,
            SlotScan::Untested(_) | SlotScan::TailPassed(_) => SlotFault::Outranked,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Pick {
    Copy { header: ShardLogHeader },
    FellBack { header: ShardLogHeader, dropped: ShardLogHeader },
    Orphan,
    Refused { slot0: SlotFault, slot1: SlotFault },
}

pub(crate) fn decode_slot(bytes: &[u8], slot: Slot) -> Result<ShardLogHeader, SlotFault> {
    let header = decode_header(bytes).map_err(|e| match e {
        FormatError::Zeroed => SlotFault::Zeroed,
        e => SlotFault::Format(e),
    })?;
    if Slot::of(header.header_seq) != slot {
        return Err(SlotFault::Parity { header_seq: header.header_seq });
    }
    Ok(header)
}

pub(crate) fn ranked(slots: [SlotScan; 2]) -> [SlotScan; 2] {
    let [zero, one] = slots;
    if one.header_seq() > zero.header_seq() { [one, zero] } else { slots }
}

pub(crate) fn pick(slots: [SlotScan; 2]) -> Pick {
    let [zero, one] = slots;
    let refused = Pick::Refused { slot0: zero.fault(), slot1: one.fault() };
    if slots.iter().any(|s| matches!(s, SlotScan::Fault(SlotFault::Parity { .. }))) {
        return refused;
    }
    match ranked(slots) {
        [SlotScan::TailPassed(header), _] => Pick::Copy { header },
        [SlotScan::TailFailed(dropped), SlotScan::TailPassed(header)] => Pick::FellBack { header, dropped },
        [SlotScan::Fault(SlotFault::Zeroed), SlotScan::Fault(SlotFault::Zeroed)] => Pick::Orphan,
        _ => refused,
    }
}
