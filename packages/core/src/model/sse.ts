export interface SseEvent {
  event: string | null;
  data: string;
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | null = null;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | null => {
    const data = dataLines.join('\n');
    const ev: SseEvent | null = dataLines.length > 0 ? { event, data } : null;
    event = null;
    dataLines = [];
    return ev;
  };

  const handleLine = (line: string): SseEvent | null => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    return null;
  };

  function* feed(text: string): Generator<SseEvent> {
    buffer += text;
    while (true) {
      let breakAt = -1;
      let step = 1;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === '\n') {
          breakAt = i;
          step = 1;
          break;
        }
        if (buffer[i] === '\r') {
          if (i + 1 < buffer.length) {
            breakAt = i;
            step = buffer[i + 1] === '\n' ? 2 : 1;
          }
          break;
        }
      }
      if (breakAt === -1) return;
      const line = buffer.slice(0, breakAt);
      buffer = buffer.slice(breakAt + step);
      const ev = handleLine(line);
      if (ev !== null) yield ev;
    }
  }

  for await (const chunk of body) {
    yield* feed(decoder.decode(chunk, { stream: true }));
  }
  yield* feed(decoder.decode());
  if (buffer.length > 0) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    buffer = '';
    const ev = handleLine(line);
    if (ev !== null) yield ev;
  }
  const ev = dispatch();
  if (ev !== null) yield ev;
}
