import Darwin
import Foundation

public enum LaunchLockError: Error, CustomStringConvertible {
    case unsafeParent
    case unsafeLockFile
    case identityChanged
    case invalidTiming
    case timeout
    case posix(action: String, errno: Int32)

    public var description: String {
        switch self {
        case .unsafeParent:
            return "Chrome CDP launch-lock parent is not a current-user directory and was not modified."
        case .unsafeLockFile:
            return "Chrome CDP launch-lock file is not a current-user, single-link regular file and was not used."
        case .identityChanged:
            return "Chrome CDP launch-lock path changed while it was being validated and was not used."
        case .invalidTiming:
            return "Chrome CDP launch-lock timeout and poll interval must be non-negative and positive, respectively."
        case .timeout:
            return "Chrome CDP launch lock is held by another launcher."
        case .posix(let action, let errorNumber):
            return "Could not \(action) Chrome CDP launch lock safely (errno \(errorNumber))."
        }
    }
}

@_spi(Testing)
public struct LockEntryIdentity: Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64

    public init(device: UInt64, inode: UInt64) {
        self.device = device
        self.inode = inode
    }
}

@_spi(Testing)
public enum LockEntryStabilizationAction: Equatable, Sendable {
    case createIfAbsent
    case openExisting
}

@_spi(Testing)
public enum LockEntryStabilizationError: Error, Equatable, Sendable {
    case identityChanged
}

@_spi(Testing)
public struct LockEntryStabilizationPolicy {
    private enum State: Equatable {
        case unobserved
        case creating
        case awaitingPeer
        case latched(LockEntryIdentity)
    }

    private var state: State = .unobserved

    public init() {}

    public mutating func observeAbsent() throws -> LockEntryStabilizationAction {
        guard case .unobserved = state else {
            throw LockEntryStabilizationError.identityChanged
        }
        state = .creating
        return .createIfAbsent
    }

    public mutating func observeExisting(_ identity: LockEntryIdentity) throws -> LockEntryStabilizationAction {
        switch state {
        case .unobserved, .awaitingPeer:
            state = .latched(identity)
            return .openExisting
        case .latched(let latched) where latched == identity:
            return .openExisting
        case .creating, .latched:
            throw LockEntryStabilizationError.identityChanged
        }
    }

    public mutating func creationLostToPeer() throws {
        guard case .creating = state else {
            throw LockEntryStabilizationError.identityChanged
        }
        state = .awaitingPeer
    }

    public mutating func created(_ identity: LockEntryIdentity) throws {
        guard case .creating = state else {
            throw LockEntryStabilizationError.identityChanged
        }
        state = .latched(identity)
    }

    public func validateOpened(_ identity: LockEntryIdentity) throws {
        guard case .latched(let latched) = state, latched == identity else {
            throw LockEntryStabilizationError.identityChanged
        }
    }

    public func entryDisappeared() throws -> Never {
        throw LockEntryStabilizationError.identityChanged
    }
}

public final class LaunchLockLease: @unchecked Sendable {
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
    private static let privateDirectoryMode: mode_t = 0o700
    private static let privateLockMode: mode_t = 0o600
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
        let parentDescriptor = try openVerifiedParentDirectory()
        defer { _ = close(parentDescriptor) }

        let lockName = lockURL.lastPathComponent
        guard !lockName.isEmpty, lockName != ".", lockName != ".." else {
            throw LaunchLockError.unsafeLockFile
        }
        let deadline = try monotonicTime() + timeout
        let stableEntry = try openStableLockEntry(
            parentDescriptor: parentDescriptor,
            name: lockName,
            deadline: deadline,
            pollInterval: pollInterval
        )
        let descriptor = stableEntry.descriptor
        var closeDescriptor = true
        defer {
            if closeDescriptor {
                _ = close(descriptor)
            }
        }
        try acquireExclusiveLock(
            descriptor,
            deadline: deadline,
            pollInterval: pollInterval,
            mayUseInitialAttempt: !stableEntry.retried
        )
        closeDescriptor = false
        return LaunchLockLease(descriptor: descriptor)
    }

    private func openVerifiedParentDirectory() throws -> Int32 {
        let parentURL = lockURL.deletingLastPathComponent()
        var observed = try lstatMetadata(at: parentURL)
        if isMissing(observed) {
            do {
                let previousUmask = umask(0o077)
                defer { umask(previousUmask) }
                if mkdir(parentURL.path, Self.privateDirectoryMode) != 0 && errno != EEXIST {
                    throw LaunchLockError.posix(action: "create launch-lock parent", errno: errno)
                }
            }
            observed = try lstatMetadata(at: parentURL)
        }
        let observedIdentity = try requireCurrentUserDirectory(observed)

        // The configured parent path's ancestors are the trusted boundary; all mutation below
        // this point uses this no-follow descriptor rather than resolving the parent path again.
        var descriptor = open(parentURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        if descriptor < 0, errno == EACCES {
            try repairUnopenableParentDirectory(at: parentURL, expectedIdentity: observedIdentity)
            descriptor = open(parentURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        }
        guard descriptor >= 0 else {
            throw LaunchLockError.posix(action: "open launch-lock parent without following links", errno: errno)
        }
        var closeDescriptor = true
        defer {
            if closeDescriptor {
                _ = close(descriptor)
            }
        }

        var opened = try fstatMetadata(descriptor, action: "inspect opened launch-lock parent")
        let openedIdentity = try requireCurrentUserDirectory(opened)
        guard openedIdentity == observedIdentity else {
            throw LaunchLockError.identityChanged
        }
        if mode(of: opened) != Self.privateDirectoryMode {
            guard fchmod(descriptor, Self.privateDirectoryMode) == 0 else {
                throw LaunchLockError.posix(action: "restrict permissions on launch-lock parent", errno: errno)
            }
            opened = try fstatMetadata(descriptor, action: "verify repaired launch-lock parent")
        }
        guard FileIdentity(opened) == openedIdentity, mode(of: opened) == Self.privateDirectoryMode else {
            throw LaunchLockError.identityChanged
        }
        let postMutation = try lstatMetadata(at: parentURL)
        guard FileIdentity(postMutation) == openedIdentity, mode(of: postMutation) == Self.privateDirectoryMode else {
            throw LaunchLockError.identityChanged
        }
        closeDescriptor = false
        return descriptor
    }

    private func repairUnopenableParentDirectory(at url: URL, expectedIdentity: FileIdentity) throws {
        let name = url.lastPathComponent
        guard isSinglePathComponent(name) else {
            throw LaunchLockError.identityChanged
        }
        let ancestorURL = url.deletingLastPathComponent()
        let ancestorDescriptor = try openVerifiedCurrentUserDirectory(
            at: ancestorURL,
            action: "open launch-lock parent ancestor without following links"
        )
        defer { _ = close(ancestorDescriptor) }

        let before = try fstatAt(ancestorDescriptor, name: name, action: "inspect inaccessible launch-lock parent")
        guard try requireCurrentUserDirectory(before) == expectedIdentity else {
            throw LaunchLockError.identityChanged
        }
        guard fchmodat(ancestorDescriptor, name, Self.privateDirectoryMode, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw LaunchLockError.posix(action: "restrict permissions on inaccessible launch-lock parent", errno: errno)
        }
        let after = try fstatAt(ancestorDescriptor, name: name, action: "verify repaired inaccessible launch-lock parent")
        guard try requireCurrentUserDirectory(after) == expectedIdentity,
              mode(of: after) == Self.privateDirectoryMode else {
            throw LaunchLockError.identityChanged
        }
    }

    private func openVerifiedCurrentUserDirectory(at url: URL, action: String) throws -> Int32 {
        let observed = try lstatMetadata(at: url)
        let observedIdentity = try requireCurrentUserDirectory(observed)
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw LaunchLockError.posix(action: action, errno: errno)
        }
        var closeDescriptor = true
        defer {
            if closeDescriptor {
                _ = close(descriptor)
            }
        }
        let opened = try fstatMetadata(descriptor, action: "inspect opened launch-lock parent ancestor")
        guard try requireCurrentUserDirectory(opened) == observedIdentity else {
            throw LaunchLockError.identityChanged
        }
        closeDescriptor = false
        return descriptor
    }

    private func openStableLockEntry(
        parentDescriptor: Int32,
        name: String,
        deadline: TimeInterval,
        pollInterval: TimeInterval
    ) throws -> StableLockEntry {
        do {
            return try stabilizeLockEntry(
                parentDescriptor: parentDescriptor,
                name: name,
                deadline: deadline,
                pollInterval: pollInterval
            )
        } catch is LockEntryStabilizationError {
            throw LaunchLockError.identityChanged
        }
    }

    private func stabilizeLockEntry(
        parentDescriptor: Int32,
        name: String,
        deadline: TimeInterval,
        pollInterval: TimeInterval
    ) throws -> StableLockEntry {
        var isInitialObservation = true
        var retried = false
        var policy = LockEntryStabilizationPolicy()
        while true {
            if !isInitialObservation, try monotonicTime() >= deadline {
                throw LaunchLockError.timeout
            }
            isInitialObservation = false
            let existing = try lstatLockEntry(parentDescriptor: parentDescriptor, name: name)
            let flags: Int32
            if let existing {
                _ = try policy.observeExisting(FileIdentity(existing).testingIdentity)
                flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW
            } else {
                _ = try policy.observeAbsent()
                flags = O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW
            }
            let descriptor = openat(parentDescriptor, name, flags, Self.privateLockMode)
            if descriptor < 0 {
                let openError = errno
                if existing == nil, openError == EEXIST {
                    try policy.creationLostToPeer()
                    retried = true
                    try waitForStableEntryRetry(deadline: deadline, pollInterval: pollInterval)
                    continue
                }
                if existing != nil, openError == ENOENT {
                    try policy.entryDisappeared()
                }
                throw LaunchLockError.posix(action: "open lock file without following links", errno: openError)
            }
            var closeDescriptor = true
            defer {
                if closeDescriptor {
                    _ = close(descriptor)
                }
            }

            let opened = try fstatMetadata(descriptor, action: "inspect opened launch-lock file")
            let openedIdentity = try requireCurrentUserSingleLinkRegularFile(opened)
            if existing == nil {
                try policy.created(openedIdentity.testingIdentity)
            } else {
                try policy.validateOpened(openedIdentity.testingIdentity)
            }
            if mode(of: opened) != Self.privateLockMode {
                guard fchmod(descriptor, Self.privateLockMode) == 0 else {
                    throw LaunchLockError.posix(action: "restrict permissions on lock file", errno: errno)
                }
            }
            let repaired = try fstatMetadata(descriptor, action: "verify repaired launch-lock file")
            guard FileIdentity(repaired) == openedIdentity, mode(of: repaired) == Self.privateLockMode else {
                throw LaunchLockError.identityChanged
            }
            guard let current = try lstatLockEntry(parentDescriptor: parentDescriptor, name: name) else {
                try policy.entryDisappeared()
            }
            _ = try policy.observeExisting(FileIdentity(current).testingIdentity)
            guard FileIdentity(current) == openedIdentity,
                  mode(of: current) == Self.privateLockMode else {
                throw LaunchLockError.identityChanged
            }
            closeDescriptor = false
            return StableLockEntry(descriptor: descriptor, retried: retried)
        }
    }

    private func waitForStableEntryRetry(deadline: TimeInterval, pollInterval: TimeInterval) throws {
        let remaining = deadline - (try monotonicTime())
        guard remaining > 0 else {
            throw LaunchLockError.timeout
        }
        try sleepMonotonically(min(pollInterval, remaining))
    }

    private func lstatLockEntry(parentDescriptor: Int32, name: String) throws -> stat? {
        var metadata = stat()
        guard fstatat(parentDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT {
                return nil
            }
            throw LaunchLockError.posix(action: "inspect lock file", errno: errno)
        }
        _ = try requireCurrentUserSingleLinkRegularFile(metadata)
        return metadata
    }

    private func lstatMetadata(at url: URL) throws -> stat {
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT {
                return metadata
            }
            throw LaunchLockError.posix(action: "inspect", errno: errno)
        }
        return metadata
    }

    private func fstatMetadata(_ descriptor: Int32, action: String) throws -> stat {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            throw LaunchLockError.posix(action: action, errno: errno)
        }
        return metadata
    }

    private func fstatAt(_ parentDescriptor: Int32, name: String, action: String) throws -> stat {
        var metadata = stat()
        guard fstatat(parentDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw LaunchLockError.posix(action: action, errno: errno)
        }
        return metadata
    }

    private func requireCurrentUserDirectory(_ metadata: stat) throws -> FileIdentity {
        guard metadata.st_uid == currentUID, (metadata.st_mode & S_IFMT) == S_IFDIR else {
            throw LaunchLockError.unsafeParent
        }
        return FileIdentity(metadata)
    }

    private func requireCurrentUserSingleLinkRegularFile(_ metadata: stat) throws -> FileIdentity {
        guard metadata.st_uid == currentUID,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_nlink == 1 else {
            throw LaunchLockError.unsafeLockFile
        }
        return FileIdentity(metadata)
    }

    private func acquireExclusiveLock(
        _ descriptor: Int32,
        deadline: TimeInterval,
        pollInterval: TimeInterval,
        mayUseInitialAttempt: Bool
    ) throws {
        var isInitialAttempt = mayUseInitialAttempt
        while true {
            if !isInitialAttempt, try monotonicTime() >= deadline {
                throw LaunchLockError.timeout
            }
            isInitialAttempt = false
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
                return
            }
            let lockError = errno
            if lockError == EINTR {
                continue
            }
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
}

private struct FileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t

    init(_ metadata: stat) {
        device = metadata.st_dev
        inode = metadata.st_ino
    }

    var testingIdentity: LockEntryIdentity {
        LockEntryIdentity(device: UInt64(device), inode: UInt64(inode))
    }
}

private struct StableLockEntry {
    let descriptor: Int32
    let retried: Bool
}

private func isMissing(_ metadata: stat) -> Bool {
    metadata.st_mode == 0 && metadata.st_ino == 0
}

private func mode(of metadata: stat) -> mode_t {
    metadata.st_mode & 0o7777
}

private func isSinglePathComponent(_ name: String) -> Bool {
    !name.isEmpty && name != "." && name != ".." && !name.contains("/")
}
