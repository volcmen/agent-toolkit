import Darwin
import ChromeCDPTestSupport

var runner = TestRunner()
registerLauncherConfigurationTests(&runner)
exit(Int32(runner.run(arguments: CommandLine.arguments)))
