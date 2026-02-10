/**
 * Access → PostgreSQL function and format translation tables.
 * Pure data — no logic. Used by query-converter.js.
 */

// ============================================================
// Access format → PostgreSQL to_char format mapping
// ============================================================

const FORMAT_MAP = {
  'General Date': 'YYYY-MM-DD HH24:MI:SS',
  'Long Date': 'FMDay, FMMonth DD, YYYY',
  'Medium Date': 'DD-Mon-YY',
  'Short Date': 'MM/DD/YYYY',
  'Long Time': 'HH24:MI:SS',
  'Medium Time': 'HH:MI AM',
  'Short Time': 'HH24:MI',
  'mm/dd/yyyy': 'MM/DD/YYYY',
  'dd/mm/yyyy': 'DD/MM/YYYY',
  'yyyy-mm-dd': 'YYYY-MM-DD',
  'General Number': '9999999999D99',
  'Currency': 'L9G999G999D99',
  'Fixed': '9999999999D99',
  'Standard': '9G999G999D99',
  'Percent': '999D99%',
  '#,##0': 'FM9G999G990',
  '#,##0.00': 'FM9G999G990D00',
  '0': 'FM0',
  '0.00': 'FM0D00',
  '0%': 'FM0%',
  '0.00%': 'FM0D00%',
};

// ============================================================
// Function translation lookup table
// Each entry: { match: regex, name: string, transform(args): string }
// ============================================================

const FUNCTION_MAP = [
  // Null handling
  {
    match: /\bNz\s*\(/gi,
    name: 'Nz',
    transform(args) {
      if (args.length >= 2) return `COALESCE(${args[0]}, ${args[1]})`;
      return `COALESCE(${args[0]}, '')`;
    }
  },
  {
    match: /\bIsNull\s*\(/gi,
    name: 'IsNull',
    transform(args) { return `(${args[0]} IS NULL)`; }
  },
  {
    match: /\bIsDate\s*\(/gi,
    name: 'IsDate',
    transform(args) { return `(${args[0]}::text ~ '^\\d{4}-\\d{2}-\\d{2}')`; }
  },
  {
    match: /\bIsNumeric\s*\(/gi,
    name: 'IsNumeric',
    transform(args) { return `(${args[0]}::text ~ '^-?[0-9]+(\\.[0-9]+)?$')`; }
  },

  // Conditional
  {
    match: /\bIIf\s*\(/gi,
    name: 'IIf',
    transform(args) { return `CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2] || 'NULL'} END`; }
  },
  {
    match: /\bSwitch\s*\(/gi,
    name: 'Switch',
    transform(args) {
      let result = 'CASE';
      for (let i = 0; i < args.length - 1; i += 2) {
        result += ` WHEN ${args[i]} THEN ${args[i + 1]}`;
      }
      return result + ' END';
    }
  },
  {
    match: /\bChoose\s*\(/gi,
    name: 'Choose',
    transform(args) {
      let result = `CASE ${args[0]}`;
      for (let i = 1; i < args.length; i++) {
        result += ` WHEN ${i} THEN ${args[i]}`;
      }
      return result + ' END';
    }
  },

  // String functions
  { match: /\bLen\s*\(/gi, name: 'Len', transform(args) { return `LENGTH(${args[0]})`; } },
  {
    match: /\bMid\s*\(/gi,
    name: 'Mid',
    transform(args) {
      if (args.length >= 3) return `SUBSTRING(${args[0]} FROM ${args[1]} FOR ${args[2]})`;
      return `SUBSTRING(${args[0]} FROM ${args[1]})`;
    }
  },
  {
    match: /\bMid\$\s*\(/gi,
    name: 'Mid$',
    transform(args) {
      if (args.length >= 3) return `SUBSTRING(${args[0]} FROM ${args[1]} FOR ${args[2]})`;
      return `SUBSTRING(${args[0]} FROM ${args[1]})`;
    }
  },
  { match: /\bLeft\s*\(/gi, name: 'Left', transform(args) { return `LEFT(${args[0]}, ${args[1]})`; } },
  { match: /\bLeft\$\s*\(/gi, name: 'Left$', transform(args) { return `LEFT(${args[0]}, ${args[1]})`; } },
  { match: /\bRight\s*\(/gi, name: 'Right', transform(args) { return `RIGHT(${args[0]}, ${args[1]})`; } },
  { match: /\bRight\$\s*\(/gi, name: 'Right$', transform(args) { return `RIGHT(${args[0]}, ${args[1]})`; } },
  { match: /\bTrim\s*\(/gi, name: 'Trim', transform(args) { return `TRIM(${args[0]})`; } },
  { match: /\bTrim\$\s*\(/gi, name: 'Trim$', transform(args) { return `TRIM(${args[0]})`; } },
  { match: /\bLTrim\s*\(/gi, name: 'LTrim', transform(args) { return `LTRIM(${args[0]})`; } },
  { match: /\bRTrim\s*\(/gi, name: 'RTrim', transform(args) { return `RTRIM(${args[0]})`; } },
  {
    match: /\bInStr\s*\(/gi,
    name: 'InStr',
    transform(args) {
      if (args.length >= 3) {
        return `POSITION(${args[2]} IN SUBSTRING(${args[1]} FROM ${args[0]})) + ${args[0]} - 1`;
      }
      return `POSITION(${args[1]} IN ${args[0]})`;
    }
  },
  {
    match: /\bInStrRev\s*\(/gi,
    name: 'InStrRev',
    transform(args) { return `(LENGTH(${args[0]}) - POSITION(REVERSE(${args[1]}) IN REVERSE(${args[0]})) + 1)`; }
  },
  { match: /\bUCase\s*\(/gi, name: 'UCase', transform(args) { return `UPPER(${args[0]})`; } },
  { match: /\bLCase\s*\(/gi, name: 'LCase', transform(args) { return `LOWER(${args[0]})`; } },
  {
    match: /\bReplace\s*\(/gi,
    name: 'Replace',
    transform(args) { return `REPLACE(${args[0]}, ${args[1]}, ${args[2]})`; }
  },
  { match: /\bStr\s*\(/gi, name: 'Str', transform(args) { return `(${args[0]})::text`; } },
  { match: /\bStr\$\s*\(/gi, name: 'Str$', transform(args) { return `(${args[0]})::text`; } },
  {
    match: /\bStrConv\s*\(/gi,
    name: 'StrConv',
    transform(args) {
      const conv = parseInt(args[1]);
      if (conv === 1) return `UPPER(${args[0]})`;
      if (conv === 2) return `LOWER(${args[0]})`;
      if (conv === 3) return `INITCAP(${args[0]})`;
      return `(${args[0]})`;
    }
  },
  { match: /\bSpace\s*\(/gi, name: 'Space', transform(args) { return `REPEAT(' ', ${args[0]})`; } },
  { match: /\bString\s*\(/gi, name: 'String', transform(args) { return `REPEAT(${args[1]}, ${args[0]})`; } },
  { match: /\bStrReverse\s*\(/gi, name: 'StrReverse', transform(args) { return `REVERSE(${args[0]})`; } },
  { match: /\bAsc\s*\(/gi, name: 'Asc', transform(args) { return `ASCII(${args[0]})`; } },
  { match: /\bChr\s*\(/gi, name: 'Chr', transform(args) { return `CHR(${args[0]})`; } },

  // Type conversion
  { match: /\bCInt\s*\(/gi, name: 'CInt', transform(args) { return `(${args[0]})::integer`; } },
  { match: /\bCLng\s*\(/gi, name: 'CLng', transform(args) { return `(${args[0]})::bigint`; } },
  { match: /\bCDbl\s*\(/gi, name: 'CDbl', transform(args) { return `(${args[0]})::double precision`; } },
  { match: /\bCSng\s*\(/gi, name: 'CSng', transform(args) { return `(${args[0]})::real`; } },
  { match: /\bCStr\s*\(/gi, name: 'CStr', transform(args) { return `(${args[0]})::text`; } },
  { match: /\bCDate\s*\(/gi, name: 'CDate', transform(args) { return `(${args[0]})::date`; } },
  { match: /\bCBool\s*\(/gi, name: 'CBool', transform(args) { return `(${args[0]})::boolean`; } },
  { match: /\bCDec\s*\(/gi, name: 'CDec', transform(args) { return `(${args[0]})::numeric`; } },
  { match: /\bCCur\s*\(/gi, name: 'CCur', transform(args) { return `(${args[0]})::numeric(19,4)`; } },
  { match: /\bVal\s*\(/gi, name: 'Val', transform(args) { return `(${args[0]})::numeric`; } },

  // Date/Time functions
  { match: /\bDateSerial\s*\(/gi, name: 'DateSerial', transform(args) { return `make_date(${args[0]}, ${args[1]}, ${args[2]})`; } },
  { match: /\bTimeSerial\s*\(/gi, name: 'TimeSerial', transform(args) { return `make_time(${args[0]}, ${args[1]}, ${args[2]})`; } },
  {
    match: /\bDateAdd\s*\(/gi,
    name: 'DateAdd',
    transform(args) {
      const interval = args[0].replace(/"/g, '').replace(/'/g, '');
      const intervalMap = {
        'yyyy': 'year', 'q': 'month', 'm': 'month', 'd': 'day',
        'w': 'day', 'ww': 'week', 'h': 'hour', 'n': 'minute', 's': 'second'
      };
      const pgInterval = intervalMap[interval.toLowerCase()] || 'day';
      const multiplier = interval.toLowerCase() === 'q' ? `(${args[1]}) * 3` : args[1];
      return `(${args[2]} + (${multiplier}) * INTERVAL '1 ${pgInterval}')`;
    }
  },
  {
    match: /\bDateDiff\s*\(/gi,
    name: 'DateDiff',
    transform(args) {
      const interval = args[0].replace(/"/g, '').replace(/'/g, '').toLowerCase();
      switch (interval) {
        case 'd': case 'w':
          return `(${args[2]}::date - ${args[1]}::date)`;
        case 'm':
          return `(EXTRACT(YEAR FROM ${args[2]}::date) * 12 + EXTRACT(MONTH FROM ${args[2]}::date) - EXTRACT(YEAR FROM ${args[1]}::date) * 12 - EXTRACT(MONTH FROM ${args[1]}::date))::integer`;
        case 'yyyy':
          return `(EXTRACT(YEAR FROM ${args[2]}::date) - EXTRACT(YEAR FROM ${args[1]}::date))::integer`;
        case 'h':
          return `(EXTRACT(EPOCH FROM ${args[2]}::timestamp - ${args[1]}::timestamp) / 3600)::integer`;
        case 'n':
          return `(EXTRACT(EPOCH FROM ${args[2]}::timestamp - ${args[1]}::timestamp) / 60)::integer`;
        case 's':
          return `(EXTRACT(EPOCH FROM ${args[2]}::timestamp - ${args[1]}::timestamp))::integer`;
        default:
          return `(${args[2]}::date - ${args[1]}::date)`;
      }
    }
  },
  {
    match: /\bDatePart\s*\(/gi,
    name: 'DatePart',
    transform(args) {
      const interval = args[0].replace(/"/g, '').replace(/'/g, '').toLowerCase();
      const partMap = {
        'yyyy': 'YEAR', 'q': 'QUARTER', 'm': 'MONTH', 'd': 'DAY',
        'w': 'DOW', 'ww': 'WEEK', 'h': 'HOUR', 'n': 'MINUTE', 's': 'SECOND'
      };
      return `EXTRACT(${partMap[interval] || 'DAY'} FROM ${args[1]})::integer`;
    }
  },
  { match: /\bDateValue\s*\(/gi, name: 'DateValue', transform(args) { return `(${args[0]})::date`; } },
  { match: /\bTimeValue\s*\(/gi, name: 'TimeValue', transform(args) { return `(${args[0]})::time`; } },
  { match: /\bYear\s*\(/gi, name: 'Year', transform(args) { return `EXTRACT(YEAR FROM ${args[0]})::integer`; } },
  { match: /\bMonth\s*\(/gi, name: 'Month', transform(args) { return `EXTRACT(MONTH FROM ${args[0]})::integer`; } },
  { match: /\bDay\s*\(/gi, name: 'Day', transform(args) { return `EXTRACT(DAY FROM ${args[0]})::integer`; } },
  { match: /\bHour\s*\(/gi, name: 'Hour', transform(args) { return `EXTRACT(HOUR FROM ${args[0]})::integer`; } },
  { match: /\bMinute\s*\(/gi, name: 'Minute', transform(args) { return `EXTRACT(MINUTE FROM ${args[0]})::integer`; } },
  { match: /\bSecond\s*\(/gi, name: 'Second', transform(args) { return `EXTRACT(SECOND FROM ${args[0]})::integer`; } },
  { match: /\bWeekday\s*\(/gi, name: 'Weekday', transform(args) { return `EXTRACT(DOW FROM ${args[0]})::integer + 1`; } },
  { match: /\bMonthName\s*\(/gi, name: 'MonthName', transform(args) { return `to_char(make_date(2000, ${args[0]}, 1), 'FMMonth')`; } },
  { match: /\bWeekdayName\s*\(/gi, name: 'WeekdayName', transform(args) { return `to_char(make_date(2000, 1, ${args[0]}), 'FMDay')`; } },

  // Format function
  {
    match: /\bFormat\s*\(/gi,
    name: 'Format',
    transform(args) {
      const fmt = (args[1] || '').replace(/"/g, '').replace(/'/g, '');
      const pgFmt = FORMAT_MAP[fmt] || fmt;
      return `to_char(${args[0]}, '${pgFmt}')`;
    }
  },

  // Math functions
  { match: /\bInt\s*\(/gi, name: 'Int', transform(args) { return `FLOOR(${args[0]})`; } },
  { match: /\bFix\s*\(/gi, name: 'Fix', transform(args) { return `TRUNC(${args[0]})`; } },
  { match: /\bAbs\s*\(/gi, name: 'Abs', transform(args) { return `ABS(${args[0]})`; } },
  {
    match: /\bRound\s*\(/gi,
    name: 'Round',
    transform(args) {
      if (args.length >= 2) return `ROUND(${args[0]}, ${args[1]})`;
      return `ROUND(${args[0]})`;
    }
  },
  { match: /\bSgn\s*\(/gi, name: 'Sgn', transform(args) { return `SIGN(${args[0]})`; } },
  { match: /\bSqr\s*\(/gi, name: 'Sqr', transform(args) { return `SQRT(${args[0]})`; } },
  { match: /\bLog\s*\(/gi, name: 'Log', transform(args) { return `LN(${args[0]})`; } },
  { match: /\bExp\s*\(/gi, name: 'Exp', transform(args) { return `EXP(${args[0]})`; } },

  // Aggregate — First()/Last() need custom aggregates
  { match: /\bFirst\s*\(/gi, name: 'First', transform(args) { return `first_agg(${args[0]})`; } },
  { match: /\bLast\s*\(/gi, name: 'Last', transform(args) { return `last_agg(${args[0]})`; } },
];

module.exports = { FORMAT_MAP, FUNCTION_MAP };
