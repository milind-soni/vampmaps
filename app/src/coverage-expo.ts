import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";

import { CoverageClient } from "./coverage-client";
import type {
  CoverageClientOptions,
  CoverageDownloadOperation,
  CoverageFileInfo,
  CoverageFileStore,
} from "./coverage-client";
import { CoverageError } from "./coverage-model";

const DEFAULT_DIRECTORY = "vamp-coverage-v1";
const SAFE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,255}$/;

function assertSafeFileName(fileName: string): void {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) {
    throw new CoverageError("storage-failed", `Unsafe coverage cache filename: ${fileName}.`);
  }
}

/** Persistent Expo document-directory storage for downloadable area packs. */
export class ExpoCoverageFileStore implements CoverageFileStore {
  private readonly directory: Directory;

  constructor(directoryName = DEFAULT_DIRECTORY) {
    if (!SAFE_FILE_NAME.test(directoryName) || directoryName.includes("..")) {
      throw new CoverageError("storage-failed", "Coverage cache directory name is invalid.");
    }
    this.directory = new Directory(Paths.document, directoryName);
  }

  async ensureReady(): Promise<void> {
    this.directory.create({ idempotent: true, intermediates: true });
  }

  async info(fileName: string, options?: { md5?: boolean }): Promise<CoverageFileInfo> {
    const file = this.file(fileName);
    return file.exists
      ? { exists: true, bytes: file.size, md5: options?.md5 ? file.md5 : undefined }
      : { exists: false, bytes: 0, md5: null };
  }

  async readText(fileName: string): Promise<string> {
    return this.file(fileName).text();
  }

  async writeText(fileName: string, text: string): Promise<void> {
    const file = this.file(fileName);
    file.create({ overwrite: true });
    file.write(text);
  }

  async delete(fileName: string): Promise<void> {
    const file = this.file(fileName);
    if (file.exists) file.delete();
  }

  async move(fromFileName: string, toFileName: string): Promise<void> {
    const source = this.file(fromFileName);
    const destination = this.file(toFileName);
    await source.move(destination, { overwrite: true });
  }

  async list(): Promise<string[]> {
    if (!this.directory.exists) return [];
    return this.directory.list().map((entry) => entry.name);
  }

  createDownload(
    url: string,
    fileName: string,
    onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void,
  ): CoverageDownloadOperation {
    const destination = this.file(fileName);
    // The legacy task remains the SDK 57 API that returns MD5 while also exposing
    // progress and cancellation. Files are otherwise managed by the modern API.
    const task = LegacyFileSystem.createDownloadResumable(
      url,
      destination.uri,
      {
        md5: true,
        sessionType: LegacyFileSystem.FileSystemSessionType.FOREGROUND,
      },
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        onProgress({
          bytesWritten: totalBytesWritten,
          totalBytes: totalBytesExpectedToWrite,
        });
      },
    );

    return {
      start: async () => {
        const result = await task.downloadAsync();
        if (!result) throw new CoverageError("cancelled", "Area download cancelled.");
        if (result.status < 200 || result.status >= 300) {
          throw new CoverageError("download-failed", `Area download returned HTTP ${result.status}.`);
        }
        return { md5: result.md5 };
      },
      cancel: () => task.cancelAsync(),
    };
  }

  private file(fileName: string): File {
    assertSafeFileName(fileName);
    return new File(this.directory, fileName);
  }
}

export type ExpoCoverageClientOptions = Omit<CoverageClientOptions, "fileStore" | "sha256Text"> & {
  directoryName?: string;
};

/** Ready-to-use coverage client for Expo SDK 57. */
export function createExpoCoverageClient(options: ExpoCoverageClientOptions): CoverageClient {
  const { directoryName, ...clientOptions } = options;
  return new CoverageClient({
    ...clientOptions,
    fileStore: new ExpoCoverageFileStore(directoryName),
    sha256Text: (text) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
        encoding: Crypto.CryptoEncoding.HEX,
      }),
  });
}
