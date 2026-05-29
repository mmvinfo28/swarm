'use strict';

function parse(str) {
  if (!str || typeof str !== 'string') return {};
  const lines = str.split('\n');
  const result = {};
  let currentKey = null;
  let currentList = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const indent = raw.search(/\S/);

    if (indent === 0) {
      currentList = null;
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) continue;

      const key = raw.slice(0, colonIdx).trim();
      const val = raw.slice(colonIdx + 1).trim();

      if (val === '') {
        currentKey = key;
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextIndent = nextLine.search(/\S/);
          if (nextIndent > 0 && nextLine.trim().startsWith('-')) {
            result[key] = [];
            currentList = key;
          } else if (nextIndent > 0) {
            result[key] = {};
          }
        }
      } else {
        result[key] = parseValue(val);
        currentKey = null;
      }
    } else if (indent > 0 && currentKey !== null) {
      const trimmed = raw.trim();

      if (trimmed.startsWith('- ')) {
        const itemVal = trimmed.slice(2).trim();
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = [];
          currentList = currentKey;
        }
        result[currentKey].push(parseValue(itemVal));
      } else if (trimmed.startsWith('-') && trimmed.length === 1) {
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = [];
          currentList = currentKey;
        }
        result[currentKey].push('');
      } else {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const subKey = trimmed.slice(0, colonIdx).trim();
        const subVal = trimmed.slice(colonIdx + 1).trim();

        if (typeof result[currentKey] !== 'object' || Array.isArray(result[currentKey])) {
          result[currentKey] = {};
        }
        if (subVal === '') {
          result[currentKey][subKey] = {};
          const nestedKey = currentKey;
          const nestedSubKey = subKey;
          for (let j = i + 1; j < lines.length; j++) {
            const nestedLine = lines[j];
            if (nestedLine.trim() === '' || nestedLine.trim().startsWith('#')) continue;
            const nestedIndent = nestedLine.search(/\S/);
            if (nestedIndent <= indent) break;
            const nt = nestedLine.trim();
            if (nt.startsWith('- ')) {
              if (!Array.isArray(result[nestedKey][nestedSubKey])) {
                result[nestedKey][nestedSubKey] = [];
              }
              result[nestedKey][nestedSubKey].push(parseValue(nt.slice(2).trim()));
              i = j;
            } else {
              const nc = nt.indexOf(':');
              if (nc === -1) continue;
              if (typeof result[nestedKey][nestedSubKey] !== 'object' || Array.isArray(result[nestedKey][nestedSubKey])) {
                result[nestedKey][nestedSubKey] = {};
              }
              result[nestedKey][nestedSubKey][nt.slice(0, nc).trim()] = parseValue(nt.slice(nc + 1).trim());
              i = j;
            }
          }
        } else {
          result[currentKey][subKey] = parseValue(subVal);
        }
      }
    }
  }
  return result;
}

function parseValue(val) {
  if (val === '' || val === 'null' || val === '~') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;

  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }

  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => parseValue(s.trim()));
  }

  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);

  return val;
}

function serialize(obj, indent) {
  if (obj === null || obj === undefined) return '';
  indent = indent || 0;
  const prefix = '  '.repeat(indent);
  const lines = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        lines.push(`${prefix}-`);
        lines.push(serialize(item, indent + 1));
      } else {
        lines.push(`${prefix}- ${serializeValue(item)}`);
      }
    }
    return lines.join('\n');
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    for (const key of keys) {
      const val = obj[key];
      if (val === null || val === undefined) {
        lines.push(`${prefix}${key}: null`);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          lines.push(`${prefix}${key}: []`);
        } else {
          lines.push(`${prefix}${key}:`);
          lines.push(serialize(val, indent + 1));
        }
      } else if (typeof val === 'object') {
        lines.push(`${prefix}${key}:`);
        lines.push(serialize(val, indent + 1));
      } else {
        lines.push(`${prefix}${key}: ${serializeValue(val)}`);
      }
    }
    return lines.join('\n');
  }

  return `${prefix}${serializeValue(obj)}`;
}

function serializeValue(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val.toString();
  if (typeof val === 'number') return val.toString();
  if (typeof val === 'string') {
    if (val === '' || val === 'null' || val === 'true' || val === 'false' ||
        /^-?\d+(\.\d+)?$/.test(val) || val.includes(':') || val.includes('#') ||
        val.includes('\n') || val.includes('"') || val.includes("'") ||
        val.startsWith(' ') || val.endsWith(' ') || val.startsWith('[') ||
        val.startsWith('{')) {
      return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return val;
  }
  return String(val);
}

module.exports = { parse, serialize, parseValue, serializeValue };
