use super::header::{ShardLogHeader, decode_header};
use super::layout::Slot;
use crate::disk::error::FormatError;
use crate::primitives::monotonic_seq::{HeaderSeq, WalSeq};

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
pub(crate) enum SlotCheck {
    Passed,
    OpenFailed,
    TailFailed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Pick {
    Copy { slot: Slot, header: ShardLogHeader },
    FellBack { from: Slot, to: Slot, header: ShardLogHeader, dropped_through: WalSeq },
    Orphan,
    Refused { slot0: SlotFault, slot1: SlotFault },
}

fn parity_slot(header_seq: HeaderSeq) -> Slot {
    match header_seq.get() % 2 {
        0 => Slot::Zero,
        _ => Slot::One,
    }
}

pub(crate) fn decode_slot(bytes: &[u8], slot: Slot) -> Result<ShardLogHeader, SlotFault> {
    let header = decode_header(bytes).map_err(|e| match e {
        FormatError::Zeroed => SlotFault::Zeroed,
        e => SlotFault::Format(e),
    })?;
    if parity_slot(header.header_seq) != slot {
        return Err(SlotFault::Parity { header_seq: header.header_seq });
    }
    Ok(header)
}

fn fault(check: SlotCheck) -> SlotFault {
    match check {
        SlotCheck::Passed => SlotFault::Outranked,
        SlotCheck::OpenFailed => SlotFault::OpenCheck,
        SlotCheck::TailFailed => SlotFault::TailCheck,
    }
}

fn refused(slot: Slot, winner: SlotFault, other: SlotFault) -> Pick {
    match slot {
        Slot::Zero => Pick::Refused { slot0: winner, slot1: other },
        Slot::One => Pick::Refused { slot0: other, slot1: winner },
    }
}

pub(crate) fn pick(slots: [Result<ShardLogHeader, SlotFault>; 2], checks: [SlotCheck; 2]) -> Pick {
    let [c0, c1] = checks;
    let [r0, r1] = slots;
    let fault_of = |r: &Result<ShardLogHeader, SlotFault>, check| match r {
        Ok(_) => fault(check),
        Err(f) => *f,
    };
    match (r0, r1) {
        (Err(SlotFault::Parity { .. }), _) | (_, Err(SlotFault::Parity { .. })) => Pick::Refused { slot0: fault_of(&r0, c0), slot1: fault_of(&r1, c1) },
        (Ok(h0), Ok(h1)) => {
            let ((win, w, w_check), (lose, l, l_check)) = match parity_slot(h0.header_seq.max(h1.header_seq)) {
                Slot::One => ((Slot::One, h1, c1), (Slot::Zero, h0, c0)),
                Slot::Zero => ((Slot::Zero, h0, c0), (Slot::One, h1, c1)),
            };
            match (w_check, l_check) {
                (SlotCheck::Passed, _) => Pick::Copy { slot: win, header: w },
                (SlotCheck::TailFailed, SlotCheck::Passed) => Pick::FellBack { from: win, to: lose, header: l, dropped_through: w.write_cursor.wal_seq },
                (w_check, l_check) => refused(win, fault(w_check), fault(l_check)),
            }
        }
        (Ok(header), Err(other)) => match c0 {
            SlotCheck::Passed => Pick::Copy { slot: Slot::Zero, header },
            check => refused(Slot::Zero, fault(check), other),
        },
        (Err(other), Ok(header)) => match c1 {
            SlotCheck::Passed => Pick::Copy { slot: Slot::One, header },
            check => refused(Slot::One, fault(check), other),
        },
        (Err(SlotFault::Zeroed), Err(SlotFault::Zeroed)) => Pick::Orphan,
        (Err(slot0), Err(slot1)) => Pick::Refused { slot0, slot1 },
    }
}
