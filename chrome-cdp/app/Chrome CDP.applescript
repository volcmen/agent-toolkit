on run
	set appPath to POSIX path of (path to me)
	set helperPath to appPath & "Contents/Resources/chrome-cdp-helper"
	try
		set resultText to do shell script quoted form of helperPath
		display notification resultText with title "Chrome CDP"
	on error errorMessage number errorNumber
		display alert "Chrome CDP could not start" message errorMessage as critical
	end try
end run
