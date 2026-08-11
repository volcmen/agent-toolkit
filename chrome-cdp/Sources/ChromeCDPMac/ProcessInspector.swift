import ChromeCDPCore
import Darwin
import Foundation

public enum ProcessInspectorError: Error, Equatable, Sendable {
    case enumerationFailed
    case malformedArguments
    case observationFailed
}

@_spi(Testing)
public struct ProcessCaptureResult: Sendable {
    public let status: Int32
    public let standardOutput: Data
    public let standardError: Data

    public init(status: Int32, standardOutput: Data, standardError: Data) {
        self.status = status
        self.standardOutput = standardOutput
        self.standardError = standardError
    }
}

private final class CapturedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func set(_ data: Data) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

public struct ProcessInspector: Sendable {
    private let candidatePIDs: @Sendable () throws -> [Int32]
    private let executablePath: @Sendable (Int32) throws -> String
    private let argumentData: @Sendable (Int32) throws -> Data

    public init() {
        candidatePIDs = { try Self.systemCandidatePIDs() }
        executablePath = { try Self.systemExecutablePath(pid: $0) }
        argumentData = { try Self.systemArgumentData(pid: $0) }
    }

    @_spi(Testing)
    public init(
        candidatePIDs: @escaping @Sendable () throws -> [Int32],
        executablePath: @escaping @Sendable (Int32) throws -> String,
        argumentData: @escaping @Sendable (Int32) throws -> Data
    ) {
        self.candidatePIDs = candidatePIDs
        self.executablePath = executablePath
        self.argumentData = argumentData
    }

    public func inspect() throws -> [ProcessObservation] {
        var observations: [ProcessObservation] = []
        for pid in try candidatePIDs() {
            do {
                let path = try executablePath(pid)
                let arguments = try Self.parseKernelProcArgs2(argumentData(pid))
                observations.append(ProcessObservation(pid: pid, executablePath: path, arguments: arguments))
            } catch let error as ProcessInspectorError where error == .malformedArguments {
                throw error
            } catch {
                if Self.isGoneOrInaccessible(error) {
                    continue
                }
                throw ProcessInspectorError.observationFailed
            }
        }
        return observations
    }

    @_spi(Testing)
    public static func parseKernelProcArgs2(_ data: Data) throws -> [String] {
        guard data.count >= MemoryLayout<Int32>.size else {
            throw ProcessInspectorError.malformedArguments
        }
        let argumentCount: Int32 = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: 0, as: Int32.self).littleEndian
        }
        guard argumentCount > 0 else {
            throw ProcessInspectorError.malformedArguments
        }

        var offset = MemoryLayout<Int32>.size
        guard let executableEnd = data[offset...].firstIndex(of: 0),
              executableEnd > offset,
              String(data: data[offset..<executableEnd], encoding: .utf8) != nil else {
            throw ProcessInspectorError.malformedArguments
        }
        offset = executableEnd + 1

        // KERN_PROCARGS2 pads between the executable and argv[0].  Once argv starts,
        // NUL is an argument terminator and therefore preserves empty later arguments.
        while offset < data.count, data[offset] == 0 {
            offset += 1
        }

        // Each argv entry needs at least its terminating NUL.  Validate this before
        // converting the kernel-owned count or reserving storage from it.
        guard argumentCount <= data.count - offset else {
            throw ProcessInspectorError.malformedArguments
        }

        var arguments: [String] = []
        arguments.reserveCapacity(Int(argumentCount))
        for _ in 0..<argumentCount {
            guard offset < data.count,
                  let end = data[offset...].firstIndex(of: 0),
                  let argument = String(data: data[offset..<end], encoding: .utf8) else {
                throw ProcessInspectorError.malformedArguments
            }
            arguments.append(argument)
            offset = end + 1
        }
        return arguments
    }

    @_spi(Testing)
    public static func readKernelArgumentData(
        sizeQuery: () throws -> Int,
        dataRead: (inout Data) throws -> Int
    ) throws -> Data {
        let retryLimit = 3
        let maximumSize = 8 * 1024 * 1024

        for attempt in 0..<retryLimit {
            let requestedSize = try sizeQuery()
            guard requestedSize >= MemoryLayout<Int32>.size, requestedSize <= maximumSize else {
                throw ProcessInspectorError.observationFailed
            }

            var data = Data(count: requestedSize)
            do {
                let actualSize = try dataRead(&data)
                guard actualSize >= MemoryLayout<Int32>.size, actualSize <= requestedSize else {
                    throw ProcessInspectorError.observationFailed
                }
                data.count = actualSize
                return data
            } catch let error as POSIXError where error.code == .ENOMEM && attempt + 1 < retryLimit {
                continue
            }
        }
        throw ProcessInspectorError.observationFailed
    }

    @_spi(Testing)
    public static func capture(executableURL: URL, arguments: [String]) throws -> ProcessCaptureResult {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error

        try process.run()

        let outputData = CapturedData()
        let errorData = CapturedData()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outputData.set(output.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errorData.set(error.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        output.fileHandleForWriting.closeFile()
        error.fileHandleForWriting.closeFile()

        process.waitUntilExit()
        group.wait()
        return ProcessCaptureResult(
            status: process.terminationStatus,
            standardOutput: outputData.get(),
            standardError: errorData.get()
        )
    }

    private static func systemCandidatePIDs() throws -> [Int32] {
        do {
            let result = try capture(executableURL: URL(fileURLWithPath: "/bin/ps"), arguments: ["-axo", "pid="])
            guard result.status == 0,
                  let text = String(data: result.standardOutput, encoding: .utf8) else {
                throw ProcessInspectorError.enumerationFailed
            }
            return try text.split(whereSeparator: \.isNewline).map { field in
                guard let pid = Int32(field.trimmingCharacters(in: .whitespaces)), pid > 0 else {
                    throw ProcessInspectorError.enumerationFailed
                }
                return pid
            }
        } catch {
            throw ProcessInspectorError.enumerationFailed
        }
    }

    @_spi(Testing)
    public static func systemExecutablePath(pid: Int32) throws -> String {
        // proc_pidpath rejects buffers larger than PROC_PIDPATHINFO_MAXSIZE
        // (4 * MAXPATHLEN) with EOVERFLOW.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let byteCount = buffer.withUnsafeMutableBufferPointer { storage in
            proc_pidpath(pid, storage.baseAddress, UInt32(storage.count))
        }
        guard byteCount > 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
        }
        let bytes = buffer.prefix(Int(byteCount)).map { UInt8(bitPattern: $0) }
        guard let path = String(bytes: bytes, encoding: .utf8) else {
            throw ProcessInspectorError.observationFailed
        }
        return path
    }

    private static func systemArgumentData(pid: Int32) throws -> Data {
        var mib = [CTL_KERN, KERN_PROCARGS2, pid]
        return try readKernelArgumentData(
            sizeQuery: {
                var size: size_t = 0
                guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
                }
                return Int(size)
            },
            dataRead: { data in
                var size = size_t(data.count)
                let result = data.withUnsafeMutableBytes { bytes in
                    sysctl(&mib, u_int(mib.count), bytes.baseAddress, &size, nil, 0)
                }
                guard result == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
                }
                return Int(size)
            }
        )
    }

    private static func isGoneOrInaccessible(_ error: Error) -> Bool {
        guard let posix = error as? POSIXError else { return false }
        return posix.code == .ESRCH || posix.code == .EPERM || posix.code == .EACCES || posix.code == .EINVAL
    }
}
