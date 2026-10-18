export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

export function buildComposerInput(text, attachments = []) {
  const input = text ? [{ type: 'text', text }] : [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') input.push({ type: 'localImage', path: attachment.path });
    else input.push({ type: 'text', text: `Attached file: ${JSON.stringify(attachment.name)}\n${attachment.path}` });
  }
  return input;
}

export function attachmentsFromInput(input = []) {
  return input.flatMap(part => {
    if (part.type === 'localImage' && part.path) return [{ id: part.path, path: part.path, name: part.path.split(/[\\/]/).at(-1), kind: 'image', status: 'ready' }];
    if (part.type === 'text') {
      const files = [];
      for (const match of (part.text || '').matchAll(/^Attached file: (".*")\n([^\n]+)$/gm)) {
        try { files.push({ id: match[2], path: match[2], name: JSON.parse(match[1]), kind: 'file', status: 'ready' }); } catch {}
      }
      return files;
    }
    return [];
  });
}

export function composerTextFromInput(input = []) {
  return input.filter(part => part.type === 'text').map(part => (part.text || '').replace(/^Attached file: (".*")\n([^\n]+)$/gm, (whole,name) => {
    try { JSON.parse(name); return ''; } catch { return whole; }
  })).join('\n').trim();
}

export function composerInputKey(input = []) {
  return JSON.stringify([input.filter(part => part.type === 'text').map(part => part.text).join('\n'), input.filter(part => /image/i.test(part.type)).map(part => part.path || part.url || '')]);
}
