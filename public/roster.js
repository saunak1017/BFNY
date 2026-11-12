// CSV input is parsed locally; passcodes are never put in a preview or audit log.
export function parseRosterCSV(input) {
  if (typeof input !== 'string' || input.length > 150000) throw new Error('Use a CSV under 150 KB.');
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const source = input.replace(/^\uFEFF/, '');
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === undefined) throw new Error('A quoted CSV field is missing its closing quote.');
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r' || c === undefined) {
      row.push(cell.trim()); cell = ''; closed = false;
      if (c !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === '\r' && source[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed && c.trim()) throw new Error('Unexpected text after a quoted CSV field.');
      cell += c;
    }
  }
  const headers = rows.shift()?.map(h => h.toLowerCase());
  if (!headers || !headers.includes('team') || !headers.includes('member')) throw new Error('CSV needs team and member columns. Optional columns: color, passcode.');
  if (new Set(headers).size !== headers.length || headers.some(h => !['team','member','color','passcode'].includes(h))) throw new Error('Use unique columns named team, member, color, passcode.');
  if (!rows.length || rows.length > 500) throw new Error('Import between 1 and 500 member rows at a time.');
  const groups = new Map();
  for (const values of rows) {
    if (values.length !== headers.length) throw new Error('Every CSV row must have the same number of columns as its header.');
    const data = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    if (!data.team || data.team.length > 60 || !data.member || data.member.length > 80) throw new Error('Each row needs a team (up to 60 characters) and member (up to 80).');
    const key = data.team.toLowerCase();
    let group = groups.get(key);
    if (!group) { group = {name:data.team, members:[]}; groups.set(key, group); }
    for (const field of ['color','passcode']) if (data[field]) {
      if (group[field] && group[field] !== data[field]) throw new Error(`Use the same ${field} for every row in team ${data.team}.`);
      group[field] = data[field];
    }
    if (group.members.some(n => n.toLowerCase() === data.member.toLowerCase())) throw new Error(`Duplicate member in team ${data.team}: ${data.member}.`);
    group.members.push(data.member);
    if (group.members.length > 50) throw new Error('Each team can have up to 50 members.');
  }
  return [...groups.values()];
}
