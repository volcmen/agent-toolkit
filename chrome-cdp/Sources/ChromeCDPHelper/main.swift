import Darwin
import ChromeCDPMac

@main
struct ChromeCDPHelperMain {
    static func main() async {
        let status = await HelperCommandRunner.production().run(
            arguments: Array(CommandLine.arguments.dropFirst())
        )
        exit(status)
    }
}
