import AppKit
import ChromeCDPCore
import Darwin
import Foundation

extension LaunchLockError: LaunchLockAcquisitionError {
    public var isTimeout: Bool {
        if case .timeout = self { return true }
        return false
    }
}

extension LaunchLockLease: LaunchLockLeasing {}

public struct LaunchLockAdapter: LaunchLocking, Sendable {
    private let lockURL: URL

    public init(lockURL: URL) {
        self.lockURL = lockURL
    }

    public func acquire(
        timeout: TimeInterval,
        pollInterval: TimeInterval
    ) throws -> any LaunchLockLeasing {
        try LaunchLock(lockURL: lockURL).acquire(timeout: timeout, pollInterval: pollInterval)
    }
}

public struct SystemClock: LauncherClock, Sendable {
    public init() {}

    public var now: TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    public func sleep(for interval: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(interval))
    }
}

public struct MacLauncherSystem: LauncherSystem, Sendable {
    private let inspectProfile: @Sendable (URL) throws -> ProfileObservation
    private let prepareProfileEffect: @Sendable (URL) throws -> Void
    private let inspectProcesses: @Sendable () throws -> [ProcessObservation]
    private let inspectListeners: @Sendable (LauncherConfiguration) throws -> [ListenerBinding]
    private let inspectEndpoint: @Sendable (LauncherConfiguration) async -> EndpointObservation
    private let createTarget: @Sendable (LauncherConfiguration) async throws -> Void
    private let runCommand: @Sendable (URL, [String]) throws -> Int32
    private let validateInstallation: @Sendable (URL, URL) -> Bool
    private let activateApplication: @Sendable (Int32) -> Bool

    public init() {
        let processInspector = ProcessInspector()
        let listenerInspector = ListenerInspector()
        let cdpClient = CDPClient()

        inspectProfile = { try ProfileGuard().inspect($0) }
        prepareProfileEffect = { try ProfileGuard().prepare($0) }
        inspectProcesses = { try processInspector.inspect() }
        inspectListeners = { try listenerInspector.inspect(configuration: $0) }
        inspectEndpoint = { await cdpClient.inspect(configuration: $0) }
        createTarget = { try await cdpClient.createBlankTarget(configuration: $0) }
        runCommand = { executable, arguments in
            try ProcessInspector.capture(executableURL: executable, arguments: arguments).status
        }
        validateInstallation = Self.validateChromeInstallation
        activateApplication = { pid in
            guard let application = NSRunningApplication(processIdentifier: pid) else {
                return false
            }
            return application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }
    }

    @_spi(Testing)
    public init(
        inspectProfile: @escaping @Sendable (URL) throws -> ProfileObservation,
        prepareProfile: @escaping @Sendable (URL) throws -> Void,
        inspectProcesses: @escaping @Sendable () throws -> [ProcessObservation],
        inspectListeners: @escaping @Sendable (LauncherConfiguration) throws -> [ListenerBinding],
        inspectEndpoint: @escaping @Sendable (LauncherConfiguration) async -> EndpointObservation,
        createTarget: @escaping @Sendable (LauncherConfiguration) async throws -> Void,
        runCommand: @escaping @Sendable (URL, [String]) throws -> Int32,
        validateInstallation: @escaping @Sendable (URL, URL) -> Bool,
        activateApplication: @escaping @Sendable (Int32) -> Bool
    ) {
        self.inspectProfile = inspectProfile
        prepareProfileEffect = prepareProfile
        self.inspectProcesses = inspectProcesses
        self.inspectListeners = inspectListeners
        self.inspectEndpoint = inspectEndpoint
        self.createTarget = createTarget
        self.runCommand = runCommand
        self.validateInstallation = validateInstallation
        self.activateApplication = activateApplication
    }

    public func chromeIsInstalled(configuration: LauncherConfiguration) -> Bool {
        validateInstallation(configuration.chromeApplicationURL, configuration.chromeExecutableURL)
    }

    public func prepareProfile(configuration: LauncherConfiguration) throws {
        do {
            try prepareProfileEffect(configuration.profileURL)
        } catch let error as ProfileGuardError {
            switch error {
            case .unsafePath(.symlink):
                throw LauncherFailure.unsafeProfile(.symlink)
            case let .unsafePath(.wrongOwner(owner)):
                throw LauncherFailure.unsafeProfile(.wrongOwner(owner: owner))
            case .unsafePath(.notDirectory):
                throw LauncherFailure.unsafeProfile(.notDirectory)
            case .unsafePath, .identityChanged, .posix:
                throw LauncherFailure.profilePreparationFailed
            }
        } catch {
            throw LauncherFailure.profilePreparationFailed
        }
    }

    public func snapshot(configuration: LauncherConfiguration) async throws -> SystemSnapshot {
        do {
            let profile = try inspectProfile(configuration.profileURL)
            let processes = try inspectProcesses()
            let listeners = try inspectListeners(configuration)
            let endpoint = await inspectEndpoint(configuration)
            return SystemSnapshot(
                profile: profile,
                processes: processes,
                listeners: listeners,
                endpoint: endpoint
            )
        } catch let failure as LauncherFailure {
            throw failure
        } catch {
            throw LauncherFailure.observationFailed
        }
    }

    public func launchChrome(configuration: LauncherConfiguration) throws {
        let arguments = [
            "-na", "Google Chrome", "--args",
            "--remote-debugging-address=\(configuration.host)",
            "--remote-debugging-port=\(configuration.port)",
            "--user-data-dir=\(configuration.profileURL.path)",
            "--no-first-run",
            "--no-default-browser-check"
        ]
        do {
            // Trust boundary: Launch Services re-resolves the final application by name when
            // /usr/bin/open runs. The production app name and validated path are fixed, but
            // macOS owns that final resolution after descriptor-anchored validation returns.
            let status = try runCommand(URL(fileURLWithPath: "/usr/bin/open"), arguments)
            guard status == 0 else {
                throw LauncherFailure.launchFailed
            }
        } catch let failure as LauncherFailure {
            throw failure
        } catch {
            throw LauncherFailure.launchFailed
        }
    }

    public func createBlankTarget(configuration: LauncherConfiguration) async throws {
        do {
            try await createTarget(configuration)
        } catch let cancellation as CancellationError {
            throw cancellation
        } catch {
            try Task.checkCancellation()
            throw LauncherFailure.targetCreationFailed
        }
    }

    public func activate(pid: Int32) throws {
        guard activateApplication(pid) else {
            throw LauncherFailure.activationFailed(pid: pid)
        }
    }

    @_spi(Testing)
    public static func validateChromeInstallation(applicationURL: URL, executableURL: URL) -> Bool {
        let applicationComponents = applicationURL.standardizedFileURL.pathComponents
        let executableComponents = executableURL.standardizedFileURL.pathComponents
        guard executableComponents.count == applicationComponents.count + 3,
              Array(executableComponents.prefix(applicationComponents.count)) == applicationComponents,
              Array(executableComponents.suffix(3).prefix(2)) == ["Contents", "MacOS"],
              let applicationName = applicationComponents.last,
              let executableName = executableComponents.last,
              isSinglePathComponent(applicationName),
              isSinglePathComponent(executableName) else {
            return false
        }

        // The configured application parent is trusted and may itself traverse macOS aliases
        // such as /var or /tmp. Everything below it is opened relative to anchored descriptors.
        let trustedParent = applicationURL.deletingLastPathComponent()
        let parentDescriptor = open(trustedParent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parentDescriptor >= 0 else { return false }
        defer { _ = close(parentDescriptor) }

        let applicationDescriptor = openat(
            parentDescriptor,
            applicationName,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard applicationDescriptor >= 0 else { return false }
        defer { _ = close(applicationDescriptor) }

        let contentsDescriptor = openat(
            applicationDescriptor,
            "Contents",
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard contentsDescriptor >= 0 else { return false }
        defer { _ = close(contentsDescriptor) }

        let macOSDescriptor = openat(
            contentsDescriptor,
            "MacOS",
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard macOSDescriptor >= 0 else { return false }
        defer { _ = close(macOSDescriptor) }

        let executableDescriptor = openat(
            macOSDescriptor,
            executableName,
            O_EXEC | O_CLOEXEC | O_NOFOLLOW
        )
        guard executableDescriptor >= 0 else { return false }
        defer { _ = close(executableDescriptor) }

        var metadata = stat()
        guard fstat(executableDescriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              isExecutableByCurrentProcess(metadata) else {
            return false
        }
        return true
    }

    private static func isSinglePathComponent(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("/")
    }

    private static func isExecutableByCurrentProcess(_ metadata: stat) -> Bool {
        let effectiveUID = geteuid()
        let permissionBits = metadata.st_mode & 0o777
        if effectiveUID == 0 {
            return permissionBits & 0o111 != 0
        }
        if metadata.st_uid == effectiveUID {
            return permissionBits & S_IXUSR != 0
        }

        guard let effectiveGroups = effectiveGroupIDs() else { return false }
        if effectiveGroups.contains(metadata.st_gid) {
            return permissionBits & S_IXGRP != 0
        }
        return permissionBits & S_IXOTH != 0
    }

    private static func effectiveGroupIDs() -> Set<gid_t>? {
        let groupCount = getgroups(0, nil)
        guard groupCount >= 0 else { return nil }
        var groups = [gid_t](repeating: 0, count: Int(groupCount))
        if groupCount > 0 {
            let actualCount = groups.withUnsafeMutableBufferPointer { buffer in
                getgroups(groupCount, buffer.baseAddress)
            }
            guard actualCount >= 0 else { return nil }
            groups.removeSubrange(Int(actualCount)..<groups.count)
        }
        groups.append(getegid())
        return Set(groups)
    }
}

public struct HelperCommandRunner: Sendable {
    private static let usage = "usage: chrome-cdp-helper [--version | --self-check]\n"

    private let configuration: LauncherConfiguration
    private let expectedHomeDirectory: URL
    private let runLauncher: @Sendable () async throws -> LauncherOutcome
    private let writeStandardOutput: @Sendable (String) -> Void
    private let writeStandardError: @Sendable (String) -> Void

    @_spi(Testing)
    public init(
        configuration: LauncherConfiguration,
        expectedHomeDirectory: URL,
        runLauncher: @escaping @Sendable () async throws -> LauncherOutcome,
        writeStandardOutput: @escaping @Sendable (String) -> Void,
        writeStandardError: @escaping @Sendable (String) -> Void
    ) {
        self.configuration = configuration
        self.expectedHomeDirectory = expectedHomeDirectory
        self.runLauncher = runLauncher
        self.writeStandardOutput = writeStandardOutput
        self.writeStandardError = writeStandardError
    }

    public static func production() -> HelperCommandRunner {
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser
        let configuration = LauncherConfiguration.production(homeDirectory: homeDirectory)
        return HelperCommandRunner(
            configuration: configuration,
            expectedHomeDirectory: homeDirectory,
            runLauncher: {
                let runner = LauncherRunner(
                    configuration: configuration,
                    classifier: LauncherClassifier(configuration: configuration),
                    system: MacLauncherSystem(),
                    lock: LaunchLockAdapter(lockURL: configuration.lockURL),
                    clock: SystemClock()
                )
                return try await runner.run()
            },
            writeStandardOutput: { text in
                FileHandle.standardOutput.write(Data(text.utf8))
            },
            writeStandardError: { text in
                FileHandle.standardError.write(Data(text.utf8))
            }
        )
    }

    public func run(arguments: [String]) async -> Int32 {
        switch arguments {
        case ["--version"]:
            writeStandardOutput("chrome-cdp-helper 1.0.0\n")
            return 0
        case ["--self-check"]:
            return runSelfCheck()
        case []:
            return await runLaunch()
        default:
            writeStandardError(Self.usage)
            return 64
        }
    }

    private func runLaunch() async -> Int32 {
        do {
            switch try await runLauncher() {
            case let .launched(pid):
                writeStandardOutput("Chrome CDP ready — launched PID \(pid).\n")
            case let .reused(pid):
                writeStandardOutput("Chrome CDP ready — reused PID \(pid).\n")
            }
            return 0
        } catch let failure as LauncherFailure {
            writeStandardError(failure.localizedDescription + "\n")
            return failure.exitCode
        } catch let error as any LaunchLockAcquisitionError {
            let failure: LauncherFailure = error.isTimeout ? .lockTimeout : .lockFailed
            writeStandardError(failure.localizedDescription + "\n")
            return failure.exitCode
        } catch {
            let failure = LauncherFailure.observationFailed
            writeStandardError(failure.localizedDescription + "\n")
            return failure.exitCode
        }
    }

    private func runSelfCheck() -> Int32 {
        guard configuration == LauncherConfiguration.production(homeDirectory: expectedHomeDirectory) else {
            writeStandardError("Chrome CDP helper configuration is invalid.\n")
            return 24
        }

        let payload = SelfCheckPayload(
            version: "1.0.0",
            appName: "Google Chrome",
            profileSuffix: configuration.profileURL.lastPathComponent,
            host: configuration.host,
            port: configuration.port,
            timeout: configuration.readinessTimeout,
            pollInterval: configuration.pollInterval
        )
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(payload)
            guard let json = String(data: data, encoding: .utf8) else {
                throw SelfCheckError.encodingFailed
            }
            writeStandardOutput(json + "\n")
            return 0
        } catch {
            writeStandardError("Chrome CDP helper self-check could not be encoded.\n")
            return 24
        }
    }
}

private struct SelfCheckPayload: Encodable {
    let version: String
    let appName: String
    let profileSuffix: String
    let host: String
    let port: Int
    let timeout: TimeInterval
    let pollInterval: TimeInterval
}

private enum SelfCheckError: Error {
    case encodingFailed
}
