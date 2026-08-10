import ChromeCDPCore
import Darwin
import Foundation

public enum ProfileGuardError: Error, CustomStringConvertible {
    case unsafePath(ProfileObservation)
    case posix(action: String, errno: Int32)

    public var isUnsafePath: Bool {
        if case .unsafePath = self { return true }
        return false
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
        case .posix(let action, let errorNumber):
            return "Could not \(action) Chrome CDP profile safely (errno \(errorNumber))."
        }
    }
}

public struct ProfileGuard {
    private let currentUID: uid_t

    public init(currentUID: uid_t = getuid()) {
        self.currentUID = currentUID
    }

    public func inspect(_ url: URL) throws -> ProfileObservation {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT {
                return .missing
            }
            throw ProfileGuardError.posix(action: "inspect", errno: errno)
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
        return .valid(mode: UInt16(metadata.st_mode & 0o777))
    }

    public func prepare(_ url: URL) throws {
        switch try inspect(url) {
        case .missing:
            do {
                let previousUmask = umask(0o077)
                defer { umask(previousUmask) }
                if mkdir(url.path, 0o700) != 0 && errno != EEXIST {
                    throw ProfileGuardError.posix(action: "create", errno: errno)
                }
            }
            try restrictDirectoryToOwnerOnly(url)
        case .valid(let mode):
            guard mode != 0o700 else { return }
            try restrictDirectoryToOwnerOnly(url)
        case let unsafe:
            throw ProfileGuardError.unsafePath(unsafe)
        }
    }

    private func restrictDirectoryToOwnerOnly(_ url: URL) throws {
        switch try inspect(url) {
        case .valid(let mode) where mode == 0o700:
            return
        case .valid:
            guard chmod(url.path, 0o700) == 0 else {
                throw ProfileGuardError.posix(action: "restrict permissions on", errno: errno)
            }
            let repaired = try inspect(url)
            guard case .valid(let repairedMode) = repaired, repairedMode == 0o700 else {
                throw ProfileGuardError.unsafePath(repaired)
            }
        case let unsafe:
            throw ProfileGuardError.unsafePath(unsafe)
        }
    }
}
