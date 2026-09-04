// Product policy, not a claim about npm's undocumented request-size limit.
// Keep large platform-specific backends/models outside the npm distribution.
export const MAX_PRODUCT_ARCHIVE_BYTES = 50 * 1024 * 1024

export function assertProductArchiveSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PRODUCT_ARCHIVE_BYTES) {
    throw new Error(`The npm product archive must be at most ${MAX_PRODUCT_ARCHIVE_BYTES} bytes (50 MiB); keep platform backends and model weights in pinned downloads`)
  }
}
