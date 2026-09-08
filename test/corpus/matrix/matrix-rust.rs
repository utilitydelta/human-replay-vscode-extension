use std::collections::HashMap;
use std::fmt;

/// A bounded accumulator over a stream of readings.
///
/// The cap is applied at the end, not per item, so a burst that overshoots and
/// then corrects still reports the corrected total.
#[derive(Debug, Default)]
pub struct Accumulator {
    readings: Vec<i64>,
    labels: HashMap<String, usize>,
    cap: i64,
}

impl Accumulator {
    /// Build an accumulator with the given cap.
    pub fn with_cap(cap: i64) -> Self {
        Self {
            readings: Vec::new(),
            labels: HashMap::new(),
            cap,
        }
    }

    /// Push a reading, tagged by label.
    ///
    /// A label already seen keeps its first index — the tag names the series,
    /// not the sample.
    #[inline]
    pub fn push(&mut self, label: &str, value: i64) -> usize {
        let index = self.readings.len();
        self.readings.push(value);
        if !self.labels.contains_key(label) {
            self.labels.insert(label.to_string(), index);
        }
        index
    }

    pub fn total(&self) -> i64 {
        let mut sum = 0;
        for reading in &self.readings {
            if *reading > 0 {
                sum += *reading;
            } else {
                sum -= 1;
            }
        }
        if sum > self.cap {
            sum = self.cap;
        }
        sum
    }

    fn drain_negatives(&mut self) -> Vec<i64> {
        let mut dropped = Vec::new();
        let mut kept = Vec::new();
        for reading in self.readings.drain(..) {
            if reading < 0 {
                dropped.push(reading);
            } else {
                kept.push(reading);
            }
        }
        self.readings = kept;
        dropped
    }
}

impl fmt::Display for Accumulator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Accumulator({} readings)", self.readings.len())
    }
}

pub const DEFAULT_CAP: i64 = 1_000;

/// Fold a slice into an accumulator in one pass.
pub fn collect_all(values: &[i64], cap: i64) -> Accumulator {
    let mut acc = Accumulator::with_cap(cap);
    for (i, value) in values.iter().enumerate() {
        acc.push(&format!("series-{i}"), *value);
    }
    acc
}
