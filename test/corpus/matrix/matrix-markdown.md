# Readings

The accumulator collects a stream of readings and reports a bounded total.

## Setup

Install the runtime, then point the collector at a feed.

    npm install readings
    readings watch ./feed

The collector writes a rolling window to disk. Nothing is buffered in memory
beyond the window, so a long run costs the same as a short one.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `cap` | 1000 | Ceiling applied at the end of a fold |
| `dropNegatives` | false | Discard readings below zero |
| `window` | 512 | Rolling window size, in samples |

A setting left unset takes the default. There is no config file; every setting
is a flag or an environment variable.

## How the cap works

The cap is applied at the END of a fold, not per sample. A burst that
overshoots and then corrects still reports the corrected total.

That ordering matters more than it looks. Applying the cap per sample would
make the total depend on the arrival order of the samples, and a feed that
replays out of order would report a different number every run.

### Worked example

Three readings, cap 10:

- `+8` — running total 8
- `+7` — running total 15
- `-6` — running total 9

The reported total is 9, not 10.

## Troubleshooting

A total that reads as exactly the cap usually means the feed is saturated.
Raise the cap or narrow the window.

A total of zero with a live feed means the labels are colliding: every sample
is landing on the same series.
