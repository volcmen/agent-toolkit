import Foundation

public struct LauncherRunner: Sendable {
    private let configuration: LauncherConfiguration
    private let classifier: LauncherClassifier
    private let system: any LauncherSystem
    private let lock: any LaunchLocking
    private let clock: any LauncherClock

    public init(
        configuration: LauncherConfiguration,
        classifier: LauncherClassifier,
        system: any LauncherSystem,
        lock: any LaunchLocking,
        clock: any LauncherClock
    ) {
        self.configuration = configuration
        self.classifier = classifier
        self.system = system
        self.lock = lock
        self.clock = clock
    }

    public func run() async throws -> LauncherOutcome {
        let lease: any LaunchLockLeasing
        do {
            lease = try lock.acquire(
                timeout: configuration.lockTimeout,
                pollInterval: configuration.pollInterval
            )
        } catch let error as any LaunchLockAcquisitionError where error.isTimeout {
            throw LauncherFailure.lockTimeout
        } catch {
            throw error
        }
        defer { lease.release() }

        guard system.chromeIsInstalled(configuration: configuration) else {
            throw LauncherFailure.missingChrome(
                applicationPath: configuration.chromeApplicationURL.path
            )
        }

        var decision = classifier.classify(try await system.snapshot(configuration: configuration))
        switch decision {
        case .createProfile, .repairProfileMode:
            try system.prepareProfile(configuration: configuration)
            decision = classifier.classify(try await system.snapshot(configuration: configuration))
        default:
            break
        }

        return try await execute(decision)
    }

    private func execute(_ initialDecision: LauncherDecision) async throws -> LauncherOutcome {
        var launched = false

        switch initialDecision {
        case .createProfile, .repairProfileMode:
            throw LauncherFailure.profilePreparationFailed
        case .launch:
            try system.launchChrome(configuration: configuration)
            launched = true
        case let .waitForReadiness(_, lastFailure):
            return try await waitForReadiness(
                launched: false,
                initialLastFailure: lastFailure
            )
        case let .reuse(pid, createBlankTarget):
            return try await finish(
                pid: pid,
                createBlankTarget: createBlankTarget,
                launched: false
            )
        case let .fail(failure):
            throw failure
        }

        return try await waitForReadiness(
            launched: launched,
            initialLastFailure: .unavailable
        )
    }

    private func waitForReadiness(
        launched: Bool,
        initialLastFailure: EndpointFailure
    ) async throws -> LauncherOutcome {
        let deadline = clock.now + configuration.readinessTimeout
        var lastFailure = initialLastFailure

        while true {
            let remaining = deadline - clock.now
            guard remaining > 0 else {
                throw LauncherFailure.readinessTimeout(lastFailure: lastFailure)
            }

            try await clock.sleep(for: min(configuration.pollInterval, remaining))
            guard clock.now < deadline else {
                throw LauncherFailure.readinessTimeout(lastFailure: lastFailure)
            }
            let decision = classifier.classify(
                try await system.snapshot(configuration: configuration)
            )

            switch decision {
            case let .waitForReadiness(_, failure):
                lastFailure = failure
            case let .reuse(pid, createBlankTarget):
                return try await finish(
                    pid: pid,
                    createBlankTarget: createBlankTarget,
                    launched: launched
                )
            case let .fail(failure):
                throw failure
            case .launch:
                break
            case .createProfile, .repairProfileMode:
                throw LauncherFailure.profilePreparationFailed
            }
        }
    }

    private func finish(
        pid: Int32,
        createBlankTarget: Bool,
        launched: Bool
    ) async throws -> LauncherOutcome {
        if createBlankTarget {
            try await system.createBlankTarget(configuration: configuration)
        }
        try system.activate(pid: pid)
        return launched ? .launched(pid: pid) : .reused(pid: pid)
    }
}
