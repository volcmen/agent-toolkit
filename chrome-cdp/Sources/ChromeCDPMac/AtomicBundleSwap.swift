import Darwin
import Foundation

public enum AtomicBundleSwapError: Error, Equatable, Sendable {
    case invalidParent
    case invalidBundlePath
    case unsafeBundle
    case systemFailure(errno: Int32)
}

public enum AtomicBundlePublishResult: Equatable, Sendable {
    case movedIntoEmptyDestination
    case swappedExistingDestination
}

public enum AtomicBundleSwap {
    public static func publish(
        staged: URL,
        installed: URL,
        allowedParent: URL
    ) throws -> AtomicBundlePublishResult {
        let parent = allowedParent.standardizedFileURL
        guard parent.isFileURL, parent.path.hasPrefix("/"),
              try isDirectoryWithoutFollowingLinks(parent) else {
            throw AtomicBundleSwapError.invalidParent
        }
        let stagedURL = staged.standardizedFileURL
        let installedURL = installed.standardizedFileURL
        let stagedName = stagedURL.lastPathComponent
        guard stagedURL != installedURL,
              stagedURL.deletingLastPathComponent() == parent,
              installedURL.deletingLastPathComponent() == parent,
              (stagedURL.pathExtension == "app" || stagedName.hasPrefix(".Chrome CDP.app.stage-")),
              installedURL.pathExtension == "app",
              try isDirectoryWithoutFollowingLinks(stagedURL) else {
            throw AtomicBundleSwapError.invalidBundlePath
        }

        let installedMetadata = try lstatOrMissing(installedURL)
        if let installedMetadata {
            guard installedMetadata.st_mode & S_IFMT == S_IFDIR else {
                throw AtomicBundleSwapError.unsafeBundle
            }
            let status = stagedURL.path.withCString { stagedPath in
                installedURL.path.withCString { installedPath in
                    renameatx_np(AT_FDCWD, stagedPath, AT_FDCWD, installedPath, UInt32(RENAME_SWAP))
                }
            }
            guard status == 0 else { throw AtomicBundleSwapError.systemFailure(errno: errno) }
            return .swappedExistingDestination
        }

        let status = stagedURL.path.withCString { stagedPath in
            installedURL.path.withCString { installedPath in
                rename(stagedPath, installedPath)
            }
        }
        guard status == 0 else { throw AtomicBundleSwapError.systemFailure(errno: errno) }
        return .movedIntoEmptyDestination
    }

    private static func isDirectoryWithoutFollowingLinks(_ url: URL) throws -> Bool {
        guard let metadata = try lstatOrMissing(url) else { return false }
        return metadata.st_mode & S_IFMT == S_IFDIR
    }

    private static func lstatOrMissing(_ url: URL) throws -> stat? {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT { return nil }
            throw AtomicBundleSwapError.systemFailure(errno: errno)
        }
        return metadata
    }
}
