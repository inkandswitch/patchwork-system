// This function was extracted from
// https://github.com/gjtorikian/isBinaryFile/blob/main/src/index.ts#L158

const MAX_BYTES = 512;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function isBinaryCheck(
  fileBuffer: Uint8Array,
  bytesRead: number
): boolean {
  // empty file. no clue what it is.
  if (bytesRead === 0) {
    return false;
  }

  let suspiciousBytes = 0;
  const totalBytes = Math.min(bytesRead, MAX_BYTES);

  // UTF-8 BOM
  if (
    bytesRead >= 3 &&
    fileBuffer[0] === 0xef &&
    fileBuffer[1] === 0xbb &&
    fileBuffer[2] === 0xbf
  ) {
    return false;
  }

  // UTF-32 BOM
  if (
    bytesRead >= 4 &&
    fileBuffer[0] === 0x00 &&
    fileBuffer[1] === 0x00 &&
    fileBuffer[2] === 0xfe &&
    fileBuffer[3] === 0xff
  ) {
    return false;
  }

  // UTF-32 LE BOM
  if (
    bytesRead >= 4 &&
    fileBuffer[0] === 0xff &&
    fileBuffer[1] === 0xfe &&
    fileBuffer[2] === 0x00 &&
    fileBuffer[3] === 0x00
  ) {
    return false;
  }

  // GB BOM
  if (
    bytesRead >= 4 &&
    fileBuffer[0] === 0x84 &&
    fileBuffer[1] === 0x31 &&
    fileBuffer[2] === 0x95 &&
    fileBuffer[3] === 0x33
  ) {
    return false;
  }

  if (totalBytes >= 5 && PDF_HEADER.every((byte, i) => fileBuffer[i] === byte)) {
    /* PDF. This is binary. */
    return true;
  }

  // UTF-16 BE BOM
  if (bytesRead >= 2 && fileBuffer[0] === 0xfe && fileBuffer[1] === 0xff) {
    return false;
  }

  // UTF-16 LE BOM
  if (bytesRead >= 2 && fileBuffer[0] === 0xff && fileBuffer[1] === 0xfe) {
    return false;
  }

  for (let i = 0; i < totalBytes; i++) {
    if (fileBuffer[i] === 0) {
      // NULL byte--it's binary!
      return true;
    } else if (
      (fileBuffer[i] < 7 || fileBuffer[i] > 14) &&
      (fileBuffer[i] < 32 || fileBuffer[i] > 127)
    ) {
      // UTF-8 detection
      if (
        fileBuffer[i] >= 0xc0 &&
        fileBuffer[i] <= 0xdf &&
        i + 1 < totalBytes
      ) {
        i++;
        if (fileBuffer[i] >= 0x80 && fileBuffer[i] <= 0xbf) {
          continue;
        }
      } else if (
        fileBuffer[i] >= 0xe0 &&
        fileBuffer[i] <= 0xef &&
        i + 2 < totalBytes
      ) {
        i++;
        if (
          fileBuffer[i] >= 0x80 &&
          fileBuffer[i] <= 0xbf &&
          fileBuffer[i + 1] >= 0x80 &&
          fileBuffer[i + 1] <= 0xbf
        ) {
          i++;
          continue;
        }
      } else if (
        fileBuffer[i] >= 0xf0 &&
        fileBuffer[i] <= 0xf7 &&
        i + 3 < totalBytes
      ) {
        i++;
        if (
          fileBuffer[i] >= 0x80 &&
          fileBuffer[i] <= 0xbf &&
          fileBuffer[i + 1] >= 0x80 &&
          fileBuffer[i + 1] <= 0xbf &&
          fileBuffer[i + 2] >= 0x80 &&
          fileBuffer[i + 2] <= 0xbf
        ) {
          i += 2;
          continue;
        }
      }

      suspiciousBytes++;
      // Read at least 32 fileBuffer before making a decision
      if (i >= 32 && (suspiciousBytes * 100) / totalBytes > 10) {
        return true;
      }
    }
  }

  if ((suspiciousBytes * 100) / totalBytes > 10) {
    return true;
  }

  return false;
}
