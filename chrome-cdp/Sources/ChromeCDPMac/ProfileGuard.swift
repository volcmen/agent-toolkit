import ChromeCDPCore
import Darwin
import Foundation

public enum ProfileGuardError: Error, CustomStringConvertible {
    case unsafePath(ProfileObservation)
    case identityChanged
    case posix(action: String, errno: Int32)

    public var isUnsafePath: Bool {
        switch self {
        case .unsafePath, .identityChanged:
            return true
        case .posix:
            return false
        }
    }

    public var description: String {
        switch self {
        case .unsafePath(.symlink):
            return "Chrome CDP profile path is a symlink and was not modified."
        case .unsafePath(.wrongOwner(let owner)):
            return "Chrome CDP profile is owned by uid \(owner), not the current user, and was not modified."
        case .unsafePath(.notDirectory):
            return "Chrome CDP profile path is not a directory and was not modified."
        case .unsafePath:
            return "Chrome CDP profile path is unsafe and was not modified."
        case .identityChanged:
            return "Chrome CDP profile path changed while it was being validated and was not used."
        case .posix(let action, let errorNumber):
            return "Could not \(action) Chrome CDP profile safely (errno \(errorNumber))."
        }
    }
}

public struct ProfileGuard {
    private static let privateDirectoryMode: mode_t = 0o700
    private let currentUID: uid_t

    public init(currentUID: uid_t = getuid()) {
        self.currentUID = currentUID
    }

    public func inspect(_ url: URL) throws -> ProfileObservation {
        try observation(for: lstatMetadata(at: url))
    }

    public func prepare(_ url: URL) throws {
        switch try inspect(url) {
        case .missing:
            do {
                let previousUmask = umask(0o077)
                defer { umask(previousUmask) }
                if mkdir(url.path, Self.privateDirectoryMode) != 0 && errno != EEXIST {
                    throw ProfileGuardError.posix(action: "create", errno: errno)
                }
            }
        case .valid:
            break
        case let unsafe:
            throw ProfileGuardError.unsafePath(unsafe)
        }

        try withVerifiedDirectory(at: url) { descriptor, identity in
            var metadata = try fstatMetadata(descriptor, action: "inspect opened profile directory")
            if mode(of: metadata) != Self.privateDirectoryMode {
                guard fchmod(descriptor, Self.privateDirectoryMode) == 0 else {
                    throw ProfileGuardError.posix(action: "restrict permissions on", errno: errno)
                }
                metadata = try fstatMetadata(descriptor, action: "verify repaired profile directory")
            }
            guard mode(of: metadata) == Self.privateDirectoryMode else {
                throw ProfileGuardError.identityChanged
            }
            let postMutation = try lstatMetadata(at: url)
            guard FileIdentity(postMutation) == identity, mode(of: postMutation) == Self.privateDirectoryMode else {
                throw ProfileGuardError.identityChanged
            }
        }
    }

    private func withVerifiedDirectory<T>(at url: URL, _ operation: (Int32, FileIdentity) throws -> T) throws -> T {
        let observed = try lstatMetadata(at: url)
        let observedIdentity = try requireCurrentUserDirectory(observed)
        var descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        if descriptor < 0, errno == EACCES {
            try repairUnopenableDirectory(at: url, expectedIdentity: observedIdentity)
            descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else {
            throw ProfileGuardError.posix(action: "open profile directory without following links", errno: errno)
        }
        defer { _ = close(descriptor) }

        let opened = try fstatMetadata(descriptor, action: "inspect opened profile directory")
        let openedIdentity = try requireCurrentUserDirectory(opened)
        guard openedIdentity == observedIdentity else {
            throw ProfileGuardError.identityChanged
        }
        return try operation(descriptor, openedIdentity)
    }

    private func repairUnopenableDirectory(at url: URL, expectedIdentity: FileIdentity) throws {
        let name = url.lastPathComponent
        guard isSinglePathComponent(name) else {
            throw ProfileGuardError.identityChanged
        }
        let parentURL = url.deletingLastPathComponent()
        let parentDescriptor = try openVerifiedCurrentUserDirectory(at: parentURL, action: "open profile parent without following links")
        defer { _ = close(parentDescriptor) }

        let before = try fstatAt(parentDescriptor, name: name, action: "inspect inaccessible profile directory")
        guard try requireCurrentUserDirectory(before) == expectedIdentity else {
            throw ProfileGuardError.identityChanged
        }
        guard fchmodat(parentDescriptor, name, Self.privateDirectoryMode, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw ProfileGuardError.posix(action: "restrict permissions on inaccessible profile directory", errno: errno)
        }
        let after = try fstatAt(parentDescriptor, name: name, action: "verify repaired inaccessible profile directory")
        guard try requireCurrentUserDirectory(after) == expectedIdentity,
              mode(of: after) == Self.privateDirectoryMode else {
            throw ProfileGuardError.identityChanged
        }
    }

    private func openVerifiedCurrentUserDirectory(at url: URL, action: String) throws -> Int32 {
        let observed = try lstatMetadata(at: url)
        let observedIdentity = try requireCurrentUserDirectory(observed)
        // The caller's configured ancestors are trusted; this descriptor anchors the immediate child repair.
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw ProfileGuardError.posix(action: action, errno: errno)
        }
        var closeDescriptor = true
        defer {
            if closeDescriptor {
                _ = close(descriptor)
            }
        }
        let opened = try fstatMetadata(descriptor, action: "inspect opened profile parent")
        guard try requireCurrentUserDirectory(opened) == observedIdentity else {
            throw ProfileGuardError.identityChanged
        }
        closeDescriptor = false
        return descriptor
    }

    private func lstatMetadata(at url: URL) throws -> stat {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT {
                return metadata
            }
            throw ProfileGuardError.posix(action: "inspect", errno: errno)
        }
        return metadata
    }

    private func fstatMetadata(_ descriptor: Int32, action: String) throws -> stat {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            throw ProfileGuardError.posix(action: action, errno: errno)
        }
        return metadata
    }

    private func fstatAt(_ parentDescriptor: Int32, name: String, action: String) throws -> stat {
        var metadata = stat()
        guard fstatat(parentDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw ProfileGuardError.posix(action: action, errno: errno)
        }
        return metadata
    }

    private func observation(for metadata: stat) throws -> ProfileObservation {
        if metadata.st_mode == 0, metadata.st_ino == 0 {
            return .missing
        }
        if (metadata.st_mode & S_IFMT) == S_IFLNK {
            return .symlink
        }
        if metadata.st_uid != currentUID {
            return .wrongOwner(owner: UInt32(metadata.st_uid))
        }
        if (metadata.st_mode & S_IFMT) != S_IFDIR {
            return .notDirectory
        }
        return .valid(mode: UInt16(mode(of: metadata)))
    }

    private func requireCurrentUserDirectory(_ metadata: stat) throws -> FileIdentity {
        let pathObservation = try observation(for: metadata)
        guard case .valid = pathObservation else {
            throw ProfileGuardError.unsafePath(pathObservation)
        }
        return FileIdentity(metadata)
    }
}

private struct FileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t

    init(_ metadata: stat) {
        device = metadata.st_dev
        inode = metadata.st_ino
    }
}

private func mode(of metadata: stat) -> mode_t {
    metadata.st_mode & 0o7777
}

private func isSinglePathComponent(_ name: String) -> Bool {
    !name.isEmpty && name != "." && name != ".." && !name.contains("/")
}
