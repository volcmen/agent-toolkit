import Foundation

public struct LauncherClassifier: Sendable {
    private let configuration: LauncherConfiguration

    public init(configuration: LauncherConfiguration) {
        self.configuration = configuration
    }

    public func classify(_ snapshot: SystemSnapshot) -> LauncherDecision {
        switch snapshot.profile {
        case .symlink:
            return .fail(.unsafeProfile(.symlink))
        case let .wrongOwner(owner):
            return .fail(.unsafeProfile(.wrongOwner(owner: owner)))
        case .notDirectory:
            return .fail(.unsafeProfile(.notDirectory))
        case .missing:
            return .createProfile
        case let .valid(mode) where mode != 0o700:
            return .repairProfileMode
        case .valid:
            break
        }

        if let unsafeBinding = snapshot.listeners.first(where: { $0.address != configuration.host }) {
            return .fail(.nonLoopbackListener(address: unsafeBinding.address, port: unsafeBinding.port))
        }

        let processDetails = snapshot.processes.map { ($0, ParsedProcessArguments(arguments: $0.arguments)) }
        let dedicatedProfileProcesses = processDetails.filter {
            $0.0.executablePath == configuration.chromeExecutableURL.path
                && $0.1.userDataDirectory.values.contains(configuration.profileURL.path)
        }
        if let conflict = dedicatedProfileProcesses.first(where: { !isExpected($0.0, arguments: $0.1) }) {
            return .fail(.profileConflict(pid: conflict.0.pid, profilePath: configuration.profileURL.path))
        }

        let expectedProcesses = processDetails.filter { isExpected($0.0, arguments: $0.1) }
        if expectedProcesses.count > 1 {
            return .fail(.profileConflict(pid: nil, profilePath: configuration.profileURL.path))
        }

        if let wrongProfileProcess = processDetails.first(where: { process, arguments in
            process.executablePath == configuration.chromeExecutableURL.path
                && isOwnedByListener(process, listeners: snapshot.listeners)
                && arguments.userDataDirectory.hasSingleDistinctValueDifferent(from: configuration.profileURL.path)
        }) {
            return .fail(
                .wrongProfileChrome(
                    pid: wrongProfileProcess.0.pid,
                    profilePath: wrongProfileProcess.1.userDataDirectory.values[0]
                )
            )
        }

        guard let expected = expectedProcesses.first else {
            if let listener = snapshot.listeners.first {
                return .fail(.foreignListener(pid: listener.pid, port: listener.port))
            }
            return .launch
        }

        if let unmatchedListener = snapshot.listeners.first(where: { $0.pid != expected.0.pid }) {
            return .fail(.foreignListener(pid: unmatchedListener.pid, port: unmatchedListener.port))
        }
        guard snapshot.listeners.contains(where: {
            $0.pid == expected.0.pid && $0.port == UInt16(configuration.port)
        }) else {
            return .waitForReadiness(pid: expected.0.pid, lastFailure: .unavailable)
        }

        switch snapshot.endpoint {
        case .unavailable:
            return .waitForReadiness(pid: expected.0.pid, lastFailure: .unavailable)
        case let .invalid(failure):
            switch failure {
            case .invalidWebSocket, .nonLoopbackWebSocket, .wrongWebSocketPort:
                return .fail(.invalidWebSocket(failure))
            default:
                return .waitForReadiness(pid: expected.0.pid, lastFailure: failure)
            }
        case let .healthy(webSocketURL, pageTargetCount):
            guard let failure = webSocketFailure(for: webSocketURL) else {
                return .reuse(pid: expected.0.pid, createBlankTarget: pageTargetCount == 0)
            }
            return .fail(.invalidWebSocket(failure))
        }
    }

    private func isExpected(_ process: ProcessObservation, arguments: ParsedProcessArguments) -> Bool {
        process.executablePath == configuration.chromeExecutableURL.path
            && arguments.userDataDirectory.isExactly(configuration.profileURL.path)
            && arguments.remoteDebuggingAddress.isExactly(configuration.host)
            && arguments.remoteDebuggingPort.isExactly(String(configuration.port))
            && process.arguments.contains("--no-first-run")
            && process.arguments.contains("--no-default-browser-check")
    }

    private func isOwnedByListener(_ process: ProcessObservation, listeners: [ListenerBinding]) -> Bool {
        listeners.contains {
            $0.pid == process.pid && $0.port == UInt16(configuration.port)
        }
    }

    private func webSocketFailure(for url: URL) -> EndpointFailure? {
        guard url.scheme == "ws" || url.scheme == "wss" else {
            return .invalidWebSocket
        }
        guard url.port == configuration.port else {
            return .wrongWebSocketPort
        }
        guard let host = url.host, ["127.0.0.1", "localhost", "::1"].contains(host) else {
            return .nonLoopbackWebSocket
        }
        return nil
    }
}

private struct ParsedProcessArguments {
    let userDataDirectory: ParsedArgumentValues
    let remoteDebuggingAddress: ParsedArgumentValues
    let remoteDebuggingPort: ParsedArgumentValues

    init(arguments: [String]) {
        userDataDirectory = ParsedArgumentValues(arguments: arguments, name: "--user-data-dir")
        remoteDebuggingAddress = ParsedArgumentValues(arguments: arguments, name: "--remote-debugging-address")
        remoteDebuggingPort = ParsedArgumentValues(arguments: arguments, name: "--remote-debugging-port")
    }
}

private struct ParsedArgumentValues {
    let values: [String]

    init(arguments: [String], name: String) {
        var parsed: [String] = []
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == name {
                let valueIndex = index + 1
                if valueIndex < arguments.count, !arguments[valueIndex].hasPrefix("--") {
                    parsed.append(arguments[valueIndex])
                    index += 2
                    continue
                }
            } else if argument.hasPrefix("\(name)=") {
                parsed.append(String(argument.dropFirst(name.count + 1)))
            }
            index += 1
        }
        values = parsed
    }

    func isExactly(_ expected: String) -> Bool {
        !values.isEmpty && Set(values) == [expected]
    }

    func hasSingleDistinctValueDifferent(from expected: String) -> Bool {
        let distinctValues = Set(values)
        return distinctValues.count == 1 && distinctValues.first != expected
    }
}
