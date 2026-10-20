Cleanups:

Bring in MbedTLS by source and configure dynamic buffers. This will make the RAM
usage more efficient and should allow additional TLS connections, for example.

Port the new effects and self-hosted control server onto this branch.

New features:

## APP

Develop a better UI/UX for this app. The phone app should be minimalist, with a
much cleaner interface. Remove unnecessary text and buttons. Focus on a crisp
user flow from onboarding to camera mapping to the mapping workspace (skelgraph,
cleanup, upload, download, etc).

The camera UI should have a live preview that updates as the PnP algorithm runs.
The algorithm should ingest as many observations as the user is willing to
record; there should be no automatic pruning/discarding (other than the outlier
rejection already in place).

In the mapping workspace, implement a solution for managing the captured maps.
There should be a "map browser" where all of the maps that the user has captured
can be viewed, selected, modified, and deleted. The user should be able to
rename maps, add descriptions, and tag them for easier searching.

It should also be possible to connect to a device from the mapping workspace to
upload/download maps.

The device connection UI should be consistent across the app, with a clear
indication of the connection status and any errors that may occur. The user
should be able to easily switch between connected devices and manage their
connections.

Make use of iconography and visual cues to guide the user through the app. Use
consistent colors, fonts, and spacing to create a cohesive look and feel.
Animations and transitions should be smooth and intuitive, enhancing the user
experience without being distracting.

The mapping workspace should also enable previewing animations on the captured
maps, even when the device is not connected. This will allow users to review
their work and make adjustments before uploading to the device.

## FIRMWARE

Implement an effects runtime in the firmware app. This runtime should take the
form of a lightweight bytecode interpreter that can execute effects scripts. The
interpreter should be able to handle basic control flow, variable management,
and function calls. It should also support a set of built-in functions for
common operations, such as math and data structure handling.

The interpreter should have other built-ins for accessing the current time,
reading sensor data (such as an IMU, when available), reading and writing the
LED buffer, and accessing the map data (such as LED 3D coordinates and skelgraph
topology).

Also implement a compiler for the effects scripts. The compiler should take a
high-level language script and compile it to the bytecode format that the
interpreter can execute.

The compiler should be built into a wasm module that can run in the phone
webapp, such that the user can write effects scripts/shaders in the browser and
compile them to bytecode for execution on the device.

The effects scripts themselves should be loaded to the device's littlefs
filesystem when pushed to the device, and then loaded/executed from there by the
effects runtime. Ensure that the hot path for executing effects is as fast as
possible (e.g. once the littlefs file is loaded, the interpreter should execute
the bytecode directly from the flash range where the file is stored, without
going through littlefs functions, if possible, or via the lightest-weight method
otherwise possible).

## EFFECTS COMPILER

The effects compiler should have a frontend in the phone webapp that allows
users to write and edit effects scripts in a high-level language. The frontend
should provide syntax highlighting, error checking, and other features to make
it easy for users to write and debug their scripts.

In addition, the frontend should support integration with an AI model provider,
such as Claude, to allow users to generate effects scripts using natural
language prompts. The agent should be provided with a system prompt that
describes the capabilities of the effects runtime and the available built-in
functions, so that it can generate valid scripts. It should also be able to
hot-reload the preview of the generated script in the mapping workspace, so that
users can see the effects of their scripts in real-time as they iterate on the
prompts.

## PERFORMANCE MONITORING

The firmware system should export performance metrics to the phone app, which
can be used to tune the effects scripts for better performance. The metrics
should include information about the execution time of the effects scripts,
memory usage, and any other relevant performance data. The agent should be able
to analyze these metrics and provide suggestions for optimizing the scripts,
such as reducing the complexity of the algorithms or using more efficient data
structures. This should be supported in real-time if a device is connected, and
also in an offline mode where a device model is used to simulate the performance
of the scripts on the device. The device model should be able to be measured and
calibrated against real devices, so that the agent can provide accurate
performance predictions even when a device is not connected.
