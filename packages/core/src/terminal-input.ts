/** Largest single write the host accepts; larger input must be sent as several ordered writes. */
export const maxTerminalWrite = 4096;

/**
 * Splits terminal input into pieces of at most `size` UTF-16 units without cutting a surrogate pair
 * (a cut pair would turn one emoji into two replacement characters in the PTY).
 */
export function chunkTerminalInput(data: string, size: number = maxTerminalWrite): string[] {
  if (!Number.isInteger(size) || size < 2) throw new RangeError("chunk size must be an integer >= 2");
  const pieces: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1; // high surrogate at the cut
    pieces.push(data.slice(offset, end));
    offset = end;
  }
  return pieces;
}
