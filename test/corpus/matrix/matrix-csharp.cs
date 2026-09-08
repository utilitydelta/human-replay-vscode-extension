using System;
using System.Collections.Generic;
using System.Linq;

namespace Readings.Core;

/// <summary>Options for a bounded accumulator.</summary>
public sealed record AccumulatorOptions(int Cap, bool DropNegatives);

/// <summary>
/// A bounded accumulator over a stream of readings. The cap is applied at the
/// end of a fold, not per sample.
/// </summary>
public class Accumulator
{
    private readonly List<int> _readings = new();
    private readonly Dictionary<string, int> _labels = new();
    private readonly AccumulatorOptions _options;

    public Accumulator(AccumulatorOptions options)
    {
        _options = options;
    }

    /// <summary>Push a reading, tagged by label.</summary>
    /// <remarks>A label already seen keeps its first index.</remarks>
    [Obsolete("use PushChecked")]
    public int Push(string label, int value)
    {
        var index = _readings.Count;
        _readings.Add(value);
        if (!_labels.ContainsKey(label))
        {
            _labels.Add(label, index);
        }
        return index;
    }

    public int Total()
    {
        var sum = 0;
        foreach (var reading in _readings)
        {
            if (reading > 0)
            {
                sum += reading;
            }
            else
            {
                sum -= 1;
            }
        }
        if (sum > _options.Cap)
        {
            sum = _options.Cap;
        }
        return sum;
    }

    public int Total(Func<int, bool> filter)
    {
        return _readings.Where(filter).Sum();
    }

    private IReadOnlyList<int> DrainNegatives()
    {
        var dropped = _readings.Where(r => r < 0).ToList();
        _readings.RemoveAll(r => r < 0);
        return dropped;
    }

    public sealed class Snapshot
    {
        public int Count { get; init; }

        public int Sum { get; init; }
    }
}

public static class Folds
{
    public const int DefaultCap = 1000;

    public static Accumulator CollectAll(IEnumerable<int> values, int cap)
    {
        var acc = new Accumulator(new AccumulatorOptions(cap, false));
        var i = 0;
        foreach (var value in values)
        {
            acc.Push($"series-{i}", value);
            i++;
        }
        return acc;
    }
}
