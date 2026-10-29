import { createContext } from 'react'

/**
 * How the panel hands a file it made (a diagram's SVG or PNG) to the user.
 *
 * A browser download link (`<a download>`) is the obvious way, and it does nothing in VS Code's webview
 * or in Fire Code's window - reported as Save SVG and Save PNG "doing nothing, like clicking a stone
 * button". Where the host has a Save dialog (VS Code, and Fire Code through its own window), the bytes
 * go to it instead and the answer says where the file went. A plain browser keeps the download.
 */
export interface SaveOutcome {
  /** Where it was written, when the host wrote it. */
  path?: string
  /** Why it was not. */
  error?: string
  /** The user closed the dialog. */
  cancelled?: boolean
  /** Handed to the browser as a download; it says where it went. */
  downloaded?: boolean
}

export type SaveFile = (name: string, blob: Blob) => Promise<SaveOutcome>

/** A browser download - right in a plain browser tab, which shows its own download bar. */
export const downloadFile: SaveFile = async (name, blob) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoked on the next frame: revoking at once can beat the download starting.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return { downloaded: true }
}

export const SaveFileContext = createContext<SaveFile>(downloadFile)

/** The bytes as base64, for a message to the host. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}
