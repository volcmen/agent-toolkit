import Darwin
import Foundation

public enum LaunchLockError: Error, CustomStringConvertible {
    case unsafeParent
    case unsafeLockFile
    case invalidTiming
    case timeout
    case posix(action: String, errno: Int32)

    public var description: String {
        switch self {
        case .unsafeParent:
            return "Chrome CDP launch-lock parent is not a current-user directory and was not modified."
        case .unsafeLockFile:
            return "Chrome CDP launch-lock file is not a current-user regular file and was not used."
        case .invalidTiming:
            return "Chrome CDP launch-lock timeout and poll interval must be non-negative and positive, respectively."
        case .timeout:
            return "Chrome CDP launch lock is held by another launcher."
        case .posix(let action, let errorNumber):
            return "Could not \(action) Chrome CDP launch lock safely (errno \(errorNumber))."
        }
    }
}

public final class LaunchLockLease {
    private let stateLock = NSLock()
    private var descriptor: Int32?

    fileprivate init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    public func release() {
        stateLock.lock()
        let descriptor = self.descriptor
        self.descriptor = nil
        stateLock.unlock()

        guard let descriptor else { return }
        _ = flock(descriptor, LOCK_UN)
        _ = close(descriptor)
    }

    deinit {
        release()
    }
}

public struct LaunchLock {
    private let lockURL: URL
    private let currentUID: uid_t

    public init(lockURL: URL) {
        self.lockURL = lockURL
        currentUID = getuid()
    }

    public func acquire(timeout: TimeInterval, pollInterval: TimeInterval) throws -> LaunchLockLease {
        guard timeout >= 0, pollInterval > 0 else {
            throw LaunchLockError.invalidTiming
        }
        try prepareParent()
        try rejectUnsafeExistingLockPath()

        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw LaunchLockError.posix(action: "open", errno: errno)
        }
        var closeDescriptor = true
        defer {
            if closeDescriptor {
                _ = close(descriptor)
            }
        }

        try validateOpenedLockFile(descriptor)
        guard fchmod(descriptor, 0o600) == 0 else {
            throw LaunchLockError.posix(action: "restrict permissions on", errno: errno)
        }
        try acquireExclusiveLock(descriptor, timeout: timeout, pollInterval: pollInterval)

        closeDescriptor = false
        return LaunchLockLease(descriptor: descriptor)
    }

    private func prepareParent() throws {
        let parentURL = lockURL.deletingLastPathComponent()
        switch try inspectPath(parentURL) {
        case .missing:
            do {
                let previousUmask = umask(0o077)
                defer { umask(previousUmask) }
                if mkdir(parentURL.path, 0o700) != 0 && errno != EEXIST {
                    throw LaunchLockError.posix(action: "create launch-lock parent", errno: errno)
                }
            }
        case .directory:
            break
        case .regular, .unsafe:
            throw LaunchLockError.unsafeParent
        }

        guard case .directory(let mode) = try inspectPath(parentURL) else {
            throw LaunchLockError.unsafeParent
        }
        if mode != 0o700 {
            guard case .directory = try inspectPath(parentURL) else {
                throw LaunchLockError.unsafeParent
            }
            guard chmod(parentURL.path, 0o700) == 0 else {
                throw LaunchLockError.posix(action: "restrict permissions on launch-lock parent", errno: errno)
            }
        }
        guard case .directory(let finalMode) = try inspectPath(parentURL), finalMode == 0o700 else {
            throw LaunchLockError.unsafeParent
        }
    }

    private func rejectUnsafeExistingLockPath() throws {
        switch try inspectPath(lockURL) {
        case .missing, .regular:
            return
        case .directory, .unsafe:
            throw LaunchLockError.unsafeLockFile
        }
    }

    private func validateOpenedLockFile(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            throw LaunchLockError.posix(action: "inspect opened launch-lock file", errno: errno)
        }
        guard metadata.st_uid == currentUID, (metadata.st_mode & S_IFMT) == S_IFREG else {
            throw LaunchLockError.unsafeLockFile
        }
    }

    private func acquireExclusiveLock(_ descriptor: Int32, timeout: TimeInterval, pollInterval: TimeInterval) throws {
        let deadline = try monotonicTime() + timeout
        while true {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
                return
            }
            let lockError = errno
            guard lockError == EWOULDBLOCK || lockError == EAGAIN else {
                throw LaunchLockError.posix(action: "acquire", errno: lockError)
            }

            let remaining = deadline - (try monotonicTime())
            guard remaining > 0 else {
                throw LaunchLockError.timeout
            }
            try sleepMonotonically(min(pollInterval, remaining))
        }
    }

    private func monotonicTime() throws -> TimeInterval {
        var timestamp = timespec()
        guard clock_gettime(CLOCK_MONOTONIC, &timestamp) == 0 else {
            throw LaunchLockError.posix(action: "read monotonic clock", errno: errno)
        }
        return TimeInterval(timestamp.tv_sec) + TimeInterval(timestamp.tv_nsec) / 1_000_000_000
    }

    private func sleepMonotonically(_ interval: TimeInterval) throws {
        var requested = timespec(
            tv_sec: Int(interval),
            tv_nsec: Int((interval - floor(interval)) * 1_000_000_000)
        )
        while true {
            var remaining = timespec()
            if nanosleep(&requested, &remaining) == 0 {
                return
            }
            guard errno == EINTR else {
                throw LaunchLockError.posix(action: "wait for launch lock", errno: errno)
            }
            requested = remaining
        }
    }

    private func inspectPath(_ url: URL) throws -> LockPathObservation {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT {
                return .missing
            }
            throw LaunchLockError.posix(action: "inspect", errno: errno)
        }
        guard metadata.st_uid == currentUID else {
            return .unsafe
        }
        switch metadata.st_mode & S_IFMT {
        case S_IFDIR:
            return .directory(mode: UInt16(metadata.st_mode & 0o777))
        case S_IFREG:
            return .regular
        default:
            return .unsafe
        }
    }
}

private enum LockPathObservation {
    case missing
    case directory(mode: UInt16)
    case regular
    case unsafe
}
