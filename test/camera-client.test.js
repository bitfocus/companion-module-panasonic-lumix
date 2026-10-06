const assert = require('node:assert/strict')
const test = require('node:test')
const { LumixCameraClient, cameraResult, parseRecordingState } = require('../src/camera-client')
const actions = require('../src/actions')
const http = require('node:http')
const { EventEmitter } = require('node:events')

test('HTTP traces include request and response details without session credentials', async function (t) {
	const logs = []
	const client = new LumixCameraClient({ host: 'camera.test', log: (message) => logs.push(message) })
	t.mock.method(http, 'get', function (_options, callback) {
		const request = new EventEmitter()
		request.destroy = (error) => request.emit('error', error)
		process.nextTick(function () {
			const response = new EventEmitter()
			response.statusCode = 200
			response.headers = { 'content-type': 'text/plain', 'x-session_id': 'header-secret', 'set-cookie': 'cookie-secret' }
			response.setEncoding = function () {}
			callback(response)
			response.emit('data', 'ok,camera-name,new-session-secret')
			response.emit('end')
		})
		return request
	})
	const response = await client._request(80, '/cam.cgi?mode=accctrl&type=req_acc_e&value=encoded-udn&value2=encoded-name')
	assert.equal(response.body, 'ok,camera-name,new-session-secret')
	assert.equal(logs.length, 3)
	assert.match(logs[0], /HTTP #1 REQUEST GET.*req_acc_e.*timeout=15000ms/)
	assert.match(logs[1], /HTTP #1 HEADERS.*status=200.*content-type/)
	assert.match(logs[2], /HTTP #1 RESPONSE.*body="ok,camera-name,\[redacted\]"/)
	for (const secret of ['encoded-udn', 'encoded-name', 'new-session-secret', 'header-secret', 'cookie-secret']) {
		assert.ok(!logs.join('\n').includes(secret))
	}
})

test('HTTP failure traces include partial responses and redact discovery identifiers', async function (t) {
	const logs = []
	const client = new LumixCameraClient({ host: 'camera.test', log: (message) => logs.push(message) })
	t.mock.method(http, 'get', function (_options, callback) {
		const request = new EventEmitter()
		request.destroy = (error) => request.emit('error', error)
		process.nextTick(function () {
			const response = new EventEmitter()
			response.statusCode = 200
			response.headers = {}
			response.setEncoding = function () {}
			callback(response)
			response.emit('data', '<UDN>uuid:private-udn</UDN><serialNumber>private-serial</serialNumber>')
			response.emit('aborted')
		})
		return request
	})
	await assert.rejects(client._request(60606, '/Lumix/Server0/ddd'), /Camera response aborted/)
	assert.match(logs[2], /HTTP #1 FAILED.*waiting for response end.*partialBody=/)
	assert.ok(!logs.join('\n').includes('private-udn'))
	assert.ok(!logs.join('\n').includes('private-serial'))
})

test('parses camera replies and recording state', function () {
	assert.equal(cameraResult('<camrply><result>ok</result></camrply>'), 'ok')
	assert.equal(parseRecordingState('<camrply><state><rec>on</rec></state></camrply>'), true)
	assert.equal(parseRecordingState('<camrply><state><video_rec>off</video_rec></state></camrply>'), false)
	assert.equal(parseRecordingState('<camrply><state><cammode>rec</cammode></state></camrply>'), null)
})

test('record actions use their instance and only update state after command success', async function () {
	const commands = []
	const states = []
	const instance = {
		log: function () {},
		setActionDefinitions: function (value) {
			this.actionDefinitions = value
		},
		sendCommand: async function (command) {
			commands.push(command)
		},
		setRecordingState: function (state) {
			states.push(state)
		},
	}
	actions(instance)
	const definitions = instance.actionDefinitions

	assert.equal(definitions.recordingStart.callback(), undefined)
	assert.equal(definitions.recordingStop.callback(), undefined)
	await new Promise((resolve) => setImmediate(resolve))

	assert.deepEqual(commands, [
		'mode=camcmd&value=video_recstart',
		'mode=camcmd&value=video_recstop',
	])
	assert.deepEqual(states, [true, false])
})

test('background recording action waits for success and recovers from a failure', async function () {
	const states = []
	const logs = []
	let rejectStart
	const instance = {
		setActionDefinitions(value) { this.actionDefinitions = value },
		sendCommand(command) {
			if (command.includes('video_recstart')) return new Promise((_resolve, reject) => { rejectStart = reject })
			return Promise.resolve()
		},
		setRecordingState(state) { states.push(state) },
		log(level, message) { logs.push({ level, message }) },
	}
	actions(instance)
	assert.equal(instance.actionDefinitions.recordingStart.callback(), undefined)
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(states, [])
	instance.actionDefinitions.recordingStop.callback()
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(states, [false], 'Stop must not wait for Start')
	rejectStart(new Error('Camera stopped responding'))
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(states, [false])
	assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('Camera stopped responding')))
})

test('getstate test migrates old PA settings to enabled at 1s and can be disabled', async function () {
	const LumixInstance = require('../src/main')
	const config = LumixInstance.prototype.normalizeConfig({ host: 'camera.test', interval: 10000 })
	assert.equal(config.enableStatePolling, true)
	assert.equal(config.interval, 1000)
	const disabled = LumixInstance.prototype.normalizeConfig({ host: 'camera.test', interval: 10000, enableStatePolling: false })
	const instance = {
		config: disabled,
		camera: { heartbeat() { throw new Error('Heartbeat should not be sent') } },
		pollInFlight: false,
	}
	await LumixInstance.prototype.pollCameraState.call(instance)
	assert.equal(instance.pollInFlight, false)
})

test('commands wait for controller confirmation; failed pairing cannot leak its provisional session', async function () {
	for (const fail of [false, true]) {
		const client = new LumixCameraClient({ host: 'camera.test' })
		const requests = []
		let resolveName, rejectName
		client._request = async function (_port, path) {
			requests.push(path)
			if (path === '/Lumix/Server0/ddd') return { statusCode: 200, body: '<UDN>uuid:test-camera</UDN>' }
			if (path.includes('req_acc_g')) return { statusCode: 200, body: 'ok' }
			if (path.includes('req_acc_e')) return { statusCode: 200, body: 'ok,camera,remote,open,provisional-session' }
			if (path.includes('device_name')) return new Promise((resolve, reject) => { resolveName = resolve; rejectName = reject })
			return { statusCode: 200, body: '<result>ok</result>' }
		}
		const pairing = client.connect()
		const pairingOutcome = pairing.then(() => null, (error) => error)
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(client.sessionId, 'provisional-session')
		const command = client.command('mode=camcmd&value=video_recstart')
		const commandOutcome = command.then(() => null, (error) => error)
		await new Promise((resolve) => setImmediate(resolve))
		assert.ok(!requests.some((path) => path.includes('video_recstart')))
		if (fail) rejectName(new Error('Name confirmation timed out'))
		else resolveName({ statusCode: 200, body: '<result>ok</result>' })
		const [pairingError, commandError] = await Promise.all([pairingOutcome, commandOutcome])
		if (fail) {
			assert.match(pairingError.message, /Name confirmation timed out/)
			assert.match(commandError.message, /Name confirmation timed out/)
			assert.equal(client.sessionId, '')
			assert.ok(!requests.some((path) => path.includes('video_recstart')))
		} else {
			assert.equal(pairingError, null)
			assert.equal(commandError, null)
			const count = requests.length
			await client.connect()
			assert.equal(requests.length, count, 'connect must reuse the established session')
		}
	}
})

test('stale reconnect timer cannot replace an established session', function (t) {
	const LumixInstance = require('../src/main')
	let retry
	t.mock.method(global, 'setTimeout', function (callback) { retry = callback; return { timer: true } })
	const instance = {
		config: { host: 'camera.test', interval: 10000 },
		camera: { sessionId: '', _connecting: null },
		reconnectTimer: null,
		connectCamera() { throw new Error('A working session must not be replaced') },
	}
	LumixInstance.prototype.scheduleReconnect.call(instance)
	instance.camera.sessionId = 'working-session'
	retry()
	assert.equal(instance.reconnectTimer, null)
})

test('getstate errors do not reconnect or clear the session, and no-data is not success', async function () {
	const LumixInstance = require('../src/main')
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'working-session'
	let calls = 0
	client._request = async function (_port, path) {
		calls++
		assert.equal(path, '/cam.cgi?mode=getsetting&type=iso')
		return { statusCode: 200, body: '<result>err_no_data</result>' }
	}
	const instance = {
		config: { host: 'camera.test', enableStatePolling: true, interval: 1000 },
		camera: client,
		pollInFlight: false,
		data: { nextSettingIndex: 0, settingPollWarnings: {} },
		consecutivePollErrors: 0,
		updateStatus() {},
		log() {},
		reconnectAfterCritical() { return false },
		stopAfterBusy() { return false },
		scheduleReconnect() { throw new Error('Polling must not reconnect') },
	}
	await Promise.all([
		LumixInstance.prototype.pollCameraState.call(instance),
		LumixInstance.prototype.pollCameraState.call(instance),
	])
	assert.equal(calls, 1)
	assert.equal(instance.consecutivePollErrors, 1)
	assert.equal(client.sessionId, 'working-session')
})

test('critical replies invalidate the session for both commands and getstate without replay', async function () {
	for (const isPoll of [false, true]) {
		const client = new LumixCameraClient({ host: 'camera.test' })
		client.sessionId = 'existing-session'
		let calls = 0
		client._request = async function () {
			calls++
			return { statusCode: 200, body: '<camrply><result>err_critical</result></camrply>' }
		}
		await assert.rejects(isPoll ? client.heartbeat() : client.command('mode=camcmd&value=video_recstart'),
			(error) => error.cameraResult === 'err_critical')
		assert.equal(client.sessionId, '')
		assert.equal(calls, 1)
	}
})

test('critical recovery reconnects immediately once and retires the old client', async function () {
	const LumixInstance = require('../src/main')
	const oldCamera = new LumixCameraClient({ host: 'camera.test' })
	oldCamera.sessionId = 'old-session'
	let reconnects = 0
	let stops = 0
	const instance = {
		camera: oldCamera,
		log() {},
		stopPolling() { stops++ },
		createCameraClient() { this.camera = new LumixCameraClient({ host: 'camera.test' }) },
		connectCamera() { reconnects++ },
	}
	const error = Object.assign(new Error('critical'), { cameraResult: 'err_critical' })
	assert.equal(LumixInstance.prototype.reconnectAfterCritical.call(instance, error, oldCamera), true)
	assert.equal(reconnects, 1)
	assert.equal(oldCamera.sessionId, '')
	assert.equal(LumixInstance.prototype.reconnectAfterCritical.call(instance, error, oldCamera), false)
	assert.equal(reconnects, 1)
	assert.equal(stops, 1)
	await assert.rejects(oldCamera.command('mode=camcmd&value=video_recstart'), /disconnected/)
})

test('connects, sends the session header, and retries an expired session', async function (t) {
	const requests = []
	let sessionNumber = 0
	let rejectCommandOnce = true
	const client = new LumixCameraClient({ host: '127.0.0.1', accessRetryDelay: 1 })
	client._request = async function (_port, path, headers, timeout) {
		headers = headers || {}
		requests.push({ url: path, session: headers['X-SESSION_ID'], timeout: timeout || this.timeout })
		if (path === '/Lumix/Server0/ddd') {
			return {
				statusCode: 200,
				body: '<root><device><friendlyName>DC-S5M2X</friendlyName><modelName>DC-S5M2X</modelName><UDN>uuid:camera-123</UDN><pana:X_FirmVersion>2.0</pana:X_FirmVersion></device></root>',
			}
		}
		if (path.indexOf('type=req_acc_g') !== -1) return { statusCode: 200, body: 'ok' }
		if (path.indexOf('type=req_acc_e') !== -1) {
			sessionNumber += 1
			return { statusCode: 200, body: 'ok,camera-name,session-' + sessionNumber }
		}
		if (path.indexOf('type=device_name') !== -1)
			return { statusCode: 200, body: '<camrply><result>ok</result></camrply>' }
		if (path.indexOf('mode=getstate') !== -1)
			return { statusCode: 200, body: '<camrply><result>ok</result><state><rec>on</rec></state></camrply>' }
		if (path.indexOf('video_recstart') !== -1 && rejectCommandOnce) {
			rejectCommandOnce = false
			return { statusCode: 200, body: '<camrply><result>err_session</result></camrply>' }
		}
		return { statusCode: 200, body: '<camrply><result>ok</result><state><rec>on</rec></state></camrply>' }
	}

	await client.connect()
	assert.equal(client.sessionId, 'session-1')
	assert.equal(requests.filter((request) => request.url.includes('value=recmode')).length, 1)
	await client.connect()
	assert.equal(requests.filter((request) => request.url.includes('value=recmode')).length, 1, 'Established session does not repeat shooting-mode setup')
	assert.equal(cameraResult(await client.heartbeat()), 'ok')
	const heartbeatRequest = requests.find(function (item) {
		return item.url.indexOf('mode=getsetting&type=iso') !== -1
	})
	assert.equal(heartbeatRequest.session, 'session-1')
	assert.equal(heartbeatRequest.timeout, 8500)
	await client.command('mode=camcmd&value=video_recstart')
	assert.equal(client.sessionId, 'session-2')
	assert.equal(requests.filter((request) => request.url.includes('value=recmode')).length, 2, 'New session establishes shooting mode again')

	const commandRequests = requests.filter(function (item) {
		return item.url.indexOf('video_recstart') !== -1
	})
	assert.deepEqual(
		commandRequests.map(function (item) {
			return item.session
		}),
		['session-1', 'session-2'],
	)
	assert.ok(commandRequests.every((request) => request.timeout === 15000))
	const handshakeRequests = requests.filter((request) => request.url === '/Lumix/Server0/ddd' || /type=(req_acc_g|req_acc_e|device_name)/.test(request.url))
	assert.ok(handshakeRequests.length >= 7)
	assert.equal(requests.filter((request) => request.url === '/Lumix/Server0/ddd').length, 1)
	assert.ok(handshakeRequests.every((request) => request.timeout === 30000))
	assert.ok(
		requests.some(function (item) {
			return item.url.indexOf('value=63616d6572612d313233') !== -1
		}),
	)
})

test('failed pairing reuses complete discovery on retry, but host changes invalidate it', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	const requests = []
	let rejectName = true
	client._request = async function (_port, path, _headers, timeout) {
		requests.push({ path, host: this.host, timeout })
		assert.equal(timeout, path.includes('value=recmode') ? 15000 : 30000)
		if (path === '/Lumix/Server0/ddd') return { statusCode: 200, body: '<root><UDN>uuid:' + this.host + '</UDN></root>' }
		if (path.includes('req_acc_g')) return { statusCode: 200, body: 'ok' }
		if (path.includes('req_acc_e')) return { statusCode: 200, body: 'ok,camera,remote,open,session' }
		if (rejectName) {
			rejectName = false
			throw new Error('Name confirmation deadline exceeded')
		}
		return { statusCode: 200, body: '<result>ok</result>' }
	}
	await assert.rejects(client.connect(), /Name confirmation/)
	assert.equal(client.sessionId, '')
	assert.equal(client.deviceInfo.udn, 'camera.test')
	await client.connect()
	assert.equal(requests.filter((request) => request.path === '/Lumix/Server0/ddd').length, 1)
	assert.equal(requests.filter((request) => request.path.includes('req_acc_g')).length, 2)
	assert.equal(requests.filter((request) => request.path.includes('value=recmode')).length, 1)
	client.setHost('other-camera.test')
	await client.connect()
	assert.equal(client.deviceInfo.udn, 'other-camera.test')
	assert.equal(requests.filter((request) => request.path === '/Lumix/Server0/ddd').length, 2)
	client.disconnect()
	assert.equal(client.deviceInfo, null)
})

test('failed or invalid discovery is never cached and timeout override is preserved', async function () {
	const client = new LumixCameraClient({ host: 'camera.test', connectionTimeout: 12345 })
	let discoveries = 0
	client._request = async (_port, path, _headers, timeout) => {
		assert.equal(timeout, 12345)
		assert.equal(path, '/Lumix/Server0/ddd')
		discoveries++
		if (discoveries === 1) throw new Error('Partial discovery timed out')
		return { statusCode: 200, body: '<root><UDN>uuid:</UDN></root>' }
	}
	await assert.rejects(client.connect(), /Partial discovery/)
	assert.equal(client.deviceInfo, null)
	await assert.rejects(client.connect(), /did not contain a UDN/)
	assert.equal(client.deviceInfo, null)
	assert.equal(discoveries, 2)
})

test('record commands run alongside an in-flight poll without cancellation or session reset', async function () {
	const client = new LumixCameraClient({ host: '127.0.0.1' })
	client.sessionId = 'existing-session'
	const requests = []
	let finishPoll
	let pollSignal
	client._request = function (_port, path, _headers, _timeout, signal) {
		requests.push(path)
		if (signal) {
			pollSignal = signal
			return new Promise((resolve) => { finishPoll = resolve })
		}
		return Promise.resolve({ statusCode: 200, body: '<camrply><result>ok</result></camrply>' })
	}
	const heartbeat = client.heartbeat()
	const recording = client.command('mode=camcmd&value=video_recstart')
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(requests, ['/cam.cgi?mode=getsetting&type=iso', '/cam.cgi?mode=camcmd&value=video_recstart'])
	assert.equal(pollSignal.aborted, false)
	await recording
	finishPoll({ statusCode: 200, body: '<result>ok</result>' })
	assert.equal(cameraResult(await heartbeat), 'ok')
	await recording
	assert.equal(client.sessionId, 'existing-session')
	assert.deepEqual(requests, [
		'/cam.cgi?mode=getsetting&type=iso',
		'/cam.cgi?mode=camcmd&value=video_recstart',
	])
})

test('a poll timeout does not affect a concurrent command or reset its session', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'existing-session'
	let rejectPoll
	let commandSent = false
	client._request = function (_port, _path, _headers, _timeout, signal) {
		if (signal) return new Promise((_resolve, reject) => { rejectPoll = reject })
		commandSent = true
		return Promise.resolve({ statusCode: 200, body: '<result>ok</result>' })
	}
	const heartbeat = client.heartbeat()
	const heartbeatError = assert.rejects(heartbeat, /Camera request deadline exceeded/)
	const recording = client.command('mode=camcmd&value=video_recstop')
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(commandSent, true)
	rejectPoll(new Error('Camera request deadline exceeded'))
	await heartbeatError
	await recording
	assert.equal(commandSent, true)
	assert.equal(client.sessionId, 'existing-session')
})

test('Start, Stop, and polls all send independently while Start is pending', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'existing-session'
	const requests = []
	let finishStart
	client._request = function (_port, path) {
		requests.push(path)
		if (path.includes('video_recstart')) return new Promise((resolve) => { finishStart = resolve })
		return Promise.resolve({ statusCode: 200, body: '<result>ok</result>' })
	}
	const start = client.command('mode=camcmd&value=video_recstart')
	const stop = client.command('mode=camcmd&value=video_recstop')
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(cameraResult(await client.heartbeat()), 'ok')
	assert.deepEqual(requests, ['/cam.cgi?mode=camcmd&value=video_recstart', '/cam.cgi?mode=camcmd&value=video_recstop', '/cam.cgi?mode=getsetting&type=iso'])
	await stop
	finishStart({ statusCode: 200, body: '<result>ok</result>' })
	await Promise.all([start, stop])
	assert.equal(requests.length, 3)
})

test('heartbeats never overlap and the pending poll is cancelled when the client retires', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'existing-session'
	const signals = []
	client._request = function (_port, _path, _headers, _timeout, signal) {
		signals.push(signal)
		return new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})
	}
	const first = client.heartbeat()
	const second = client.heartbeat()
	assert.equal(await second, null)
	assert.equal(signals.length, 1)
	assert.ok(signals.every((signal) => !signal.aborted))
	client.disconnect()
	assert.deepEqual(await Promise.all([first, second]), [null, null])
	assert.equal(client._heartbeatControllers.size, 0)
})

test('heartbeat sends only ISO with session and 8.5s timeout and excludes overlapping polls', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'existing-session'
	const requests = []
	let resolveSetting
	client._request = async (_port, path, headers, timeout, signal) => {
		requests.push({ path, headers, timeout, signal })
		return new Promise((resolve) => { resolveSetting = resolve })
	}
	const pending = client.heartbeat()
	while (!resolveSetting) await new Promise((resolve) => setImmediate(resolve))
	assert.equal(await client.heartbeat(), null)
	assert.equal(requests.length, 1)
	assert.equal(requests[0].path, '/cam.cgi?mode=getsetting&type=iso')
	assert.equal(requests[0].headers['X-SESSION_ID'], 'existing-session')
	assert.equal(requests[0].timeout, 8500)
	resolveSetting({ statusCode: 200, body: '<result>ok</result><settingvalue iso="640"/>' })
	assert.match(await pending, /iso="640"/)
})

test('slow ISO reply causes no second request', async function (t) {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'existing-session'
	let now = 0
	t.mock.method(Date, 'now', () => now)
	let requests = 0
	client._request = async () => {
		requests += 1
		now = 8000
		return { statusCode: 200, body: '<result>ok</result>' }
	}
	assert.equal(cameraResult(await client.heartbeat()), 'ok')
	assert.equal(requests, 1)
})

test('ISO poll errors retain session except critical and busy recovery safeguards', async function () {
	for (const result of ['err_no_data', 'err_critical', 'err_busy', 'timeout']) {
		const client = new LumixCameraClient({ host: 'camera.test' })
		client.sessionId = 'existing-session'
		client._request = async (_port, path) => {
			if (result === 'timeout') throw new Error('deadline exceeded')
			return { statusCode: 200, body: '<result>' + result + '</result>' }
		}
		const pending = client.heartbeat()
		if (result === 'err_critical' || result === 'err_busy') {
			await assert.rejects(pending, (error) => error.cameraResult === result)
			assert.equal(client.sessionId, result === 'err_critical' ? '' : 'existing-session')
			assert.equal(client.safetyStopped, false)
		} else {
			await assert.rejects(pending, result === 'timeout' ? /deadline exceeded/ : /err_no_data/)
			assert.equal(client.sessionId, 'existing-session')
		}
	}
})

test('duplicate recording commands are rejected without queuing, while Stop stays independent', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'session'
	const requests = []
	let finishStart
	client._request = function (_port, path) {
		requests.push(path)
		if (path.includes('video_recstart')) return new Promise((resolve) => { finishStart = resolve })
		return Promise.resolve({ statusCode: 200, body: '<result>ok</result>' })
	}
	const start = client.command('mode=camcmd&value=video_recstart')
	await assert.rejects(client.command('mode=camcmd&value=video_recstart'), /Duplicate recording request ignored/)
	await client.command('mode=camcmd&value=video_recstop')
	assert.equal(requests.length, 2)
	finishStart({ statusCode: 200, body: '<result>ok</result>' })
	await start
	assert.equal(client._pendingRecordingCommands.size, 0)
})

test('three consecutive busy heartbeats latch a safety stop without further requests', async function () {
		const client = new LumixCameraClient({ host: 'camera.test' })
		client.sessionId = 'session'
		let calls = 0
		client._request = async function () {
			calls++
			return { statusCode: 200, body: '<result>err_busy</result>' }
		}
		for (let count = 1; count <= 3; count++) {
			await assert.rejects(client.heartbeat(), (error) => error.cameraResult === 'err_busy')
			assert.equal(client.safetyStopped, count === 3)
			assert.equal(client._busyHeartbeats, count)
		}
		assert.equal(client.safetyStopped, true)
		assert.equal(await client.heartbeat(), null)
		await assert.rejects(client.command('mode=camcmd&value=video_recstop'), /disconnected/)
		await assert.rejects(client.connect(), /disconnected/)
		assert.equal(calls, 3)
})

test('busy actions do not stop traffic or change the heartbeat busy streak', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'session'
	client._request = async () => ({ statusCode: 200, body: '<result>err_busy</result>' })
	await assert.rejects(client.command('mode=camcmd&value=video_recstart'), /err_busy/)
	assert.equal(client._busyHeartbeats, 0)
	await assert.rejects(client.heartbeat(), /err_busy/)
	await assert.rejects(client.command('mode=camcmd&value=video_recstop'), /err_busy/)
	assert.equal(client._busyHeartbeats, 1)
	assert.equal(client.safetyStopped, false)
	assert.equal(client.sessionId, 'session')
	client._request = async () => ({ statusCode: 200, body: '<result>ok</result>' })
	await client.command('mode=camcmd&value=video_recstop')
})

test('non-busy heartbeat outcomes break the busy streak; skipped ticks do not', async function () {
	for (const outcome of ['ok', 'err_no_data', 'timeout']) {
		const client = new LumixCameraClient({ host: 'camera.test' })
		client.sessionId = 'session'
		let result = 'err_busy'
		client._request = async () => {
			if (result === 'timeout') throw new Error('deadline exceeded')
			return { statusCode: 200, body: '<result>' + result + '</result>' }
		}
		await assert.rejects(client.heartbeat(), /err_busy/)
		client._connecting = Promise.resolve()
		assert.equal(await client.heartbeat(), null)
		assert.equal(client._busyHeartbeats, 1)
		client._connecting = null
		result = outcome
		if (outcome === 'ok') await client.heartbeat()
		else await assert.rejects(client.heartbeat())
		assert.equal(client._busyHeartbeats, 0)
		result = 'err_busy'
		await assert.rejects(client.heartbeat(), /err_busy/)
		await assert.rejects(client.heartbeat(), /err_busy/)
		assert.equal(client.safetyStopped, false)
	}
})

test('late control replies cannot restore success after the heartbeat safety stop', async function () {
	const client = new LumixCameraClient({ host: 'camera.test' })
	client.sessionId = 'session'
	let finish
	client._request = async (_port, path) => {
		if (path.includes('camcmd')) return new Promise((resolve) => { finish = resolve })
		return { statusCode: 200, body: '<result>err_busy</result>' }
	}
	const command = client.command('mode=camcmd&value=video_recstart')
	for (let count = 0; count < 3; count++) await assert.rejects(client.heartbeat(), /err_busy/)
	finish({ statusCode: 200, body: '<result>ok</result>' })
	await assert.rejects(command, /traffic stopped/)
})

test('busy safety stop disables timers and prevents automatic reconnect', function () {
	const LumixInstance = require('../src/main')
	const camera = { safetyStopped: true }
	let stops = 0
	let logs = 0
	const instance = {
		camera,
		stopPolling() { stops++ },
		updateStatus() {},
		checkFeedbacks() {},
		log() { logs++ },
	}
	const error = Object.assign(new Error('busy'), { cameraResult: 'err_busy' })
	camera.safetyStopped = false
	assert.equal(LumixInstance.prototype.stopAfterBusy.call(instance, error, camera), false)
	assert.equal(stops, 0)
	camera.safetyStopped = true
	assert.equal(LumixInstance.prototype.stopAfterBusy.call(instance, error, camera), true)
	LumixInstance.prototype.stopAfterBusy.call(instance, error, camera)
	assert.equal(stops, 2)
	assert.equal(logs, 1)
	LumixInstance.prototype.scheduleReconnect.call(instance)
	assert.equal(instance.reconnectTimer, undefined)
})
