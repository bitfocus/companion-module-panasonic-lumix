const test = require('node:test')
const assert = require('node:assert/strict')
const { SETTINGS, parseMenuChoices, parseSettingValue, parseTelemetry, nextIsoChoice } = require('../src/settings')
const LumixInstance = require('../src/main')
const actions = require('../src/actions')
const feedbacks = require('../src/feedbacks')
const variables = require('../src/variables')

function instance() {
	const value = {
		data: { telemetry: {}, settings: {}, settingChoices: {}, lastStateAt: 0 },
		camera: {},
		values: {},
		logs: [],
		commands: [],
		setVariableValues(values) {
			Object.assign(this.values, values)
		},
		checkFeedbacks() {},
		log(level, message) {
			this.logs.push({ level, message })
		},
		async sendCommand(command) {
			this.commands.push(command)
			return '<result>ok</result>'
		},
		setActionDefinitions(definitions) {
			this.actions = definitions
		},
		setFeedbackDefinitions(definitions) {
			this.feedbacks = definitions
		},
		setVariableDefinitions(definitions) {
			this.variables = definitions
		},
	}
	for (const name of [
		'storeSetting',
		'setCameraSetting',
		'stepIso',
		'readCameraSetting',
		'readCameraInfo',
		'fetchCameraInfo',
		'updateCameraTelemetry',
	])
		value[name] = LumixInstance.prototype[name]
	return value
}

test('menu choices use reported values and English labels without dynamic or multi-value commands', () => {
	const choices = parseMenuChoices(`<camrply><result>ok</result><menu>
		<item cmd_mode="setsetting" cmd_type="iso" cmd_value="640" title_id="title_iso"/>
		<item cmd_mode='setsetting' cmd_type='iso' cmd_value='640'/>
		<item cmd_mode="setsetting" cmd_type="colormode" cmd_value="v&amp;log"/>
		<item cmd_mode="setsetting" cmd_type="focal" cmd_value="__value__"/>
		<item cmd_mode="setsetting" cmd_type="focusmode" cmd_value="af" cmd_value2="area"/>
		<item cmd_mode="camcmd" cmd_type="iso" cmd_value="capture"/>
		<language code="en"><title id="title_iso">ISO &#54;40</title></language>
		</menu></camrply>`)
	assert.deepEqual(choices.iso, [{ id: '640', label: 'ISO 640' }])
	assert.deepEqual(choices.colormode, [{ id: 'v&log', label: 'v&log' }])
	assert.deepEqual(choices.focal, [])
	assert.deepEqual(choices.focusmode, [])
})

test('setting reads support attributes and leaf tags without treating a missing value as success', () => {
	assert.equal(parseSettingValue('<settingvalue iso="auto"/>', 'iso'), 'auto')
	assert.equal(parseSettingValue('<settingvalue focal="1366/256"></settingvalue>', 'focal'), '1366/256')
	assert.equal(parseSettingValue('<shtrspeed>2560/256</shtrspeed>', 'shtrspeed'), '2560/256')
	assert.equal(parseSettingValue('<result>ok</result>', 'iso'), null)
})

test('client reset clears last-known settings and checks explicit Companion feedback types', () => {
	const self = instance()
	self.config = { host: 'camera.test' }
	self.data.settings.iso = '800'
	self.data.lastStateAt = Date.now()
	self.checkFeedbacks = (...types) => {
		assert.ok(types.length > 0)
		assert.ok(types.includes('stateFresh'))
	}
	LumixInstance.prototype.createCameraClient.call(self)
	assert.deepEqual(self.data.settings, {})
	assert.equal(self.data.lastStateAt, 0)
	assert.equal(self.values.setting_iso, 'Unknown')
	assert.equal(self.commands.length, 0)
})

test('state telemetry preserves raw values and marks unavailable percentage and missing fields unknown', () => {
	const data = parseTelemetry(
		'<state><batt>4/5</batt><batt_per>-1</batt_per><video_remaincapacity>2361</video_remaincapacity><cammode>rec</cammode><sd_full>false</sd_full></state>',
	)
	assert.equal(data.battery_level, '4/5')
	assert.equal(data.battery_percent, 'Unknown')
	assert.equal(data.video_remaining, '2361')
	assert.equal(data.camera_mode, 'rec')
	assert.equal(data.card1_full, 'false')
	assert.equal(data.card2_status, 'Unknown')
	assert.equal(parseTelemetry('<batt_per>0</batt_per>').battery_percent, '0')
})

test('ISO stepping sorts choices numerically, excludes Auto and never wraps', () => {
	const choices = ['auto', '1600', '100', '125', '160', '200', '125', 'Unknown'].map((id) => ({ id, label: id }))
	assert.equal(nextIsoChoice(choices, '125', 1), '160')
	assert.equal(nextIsoChoice(choices, '160', -1), '125')
	assert.equal(nextIsoChoice(choices, '1600', 1), null)
	assert.equal(nextIsoChoice(choices, '100', -1), null)
	assert.equal(nextIsoChoice(choices, '140', 1), '160')
	assert.throws(() => nextIsoChoice(choices, 'auto', 1), /manual ISO/)
	assert.throws(() => nextIsoChoice([], '100', 1), /not loaded/)
})

test('unbuffered ISO presses send all targets immediately and ignore older acknowledgments', async () => {
	const self = instance()
	self.data.settingChoices.iso = ['100', '125', '160', '200'].map((id) => ({ id, label: id }))
	self.data.settings.iso = '100'
	const replies = []
	self.sendCommand = async (query) => {
		self.commands.push(query)
		return new Promise((resolve) => replies.push(resolve))
	}
	const first = self.stepIso(1)
	self.storeSetting('iso', '100') // An older heartbeat must not reset the pending target.
	const second = self.stepIso(1)
	assert.deepEqual(self.commands, ['mode=setsetting&type=iso&value=125', 'mode=setsetting&type=iso&value=160'])
	replies[1]('<result>ok</result>')
	await second
	assert.equal(self.values.setting_iso, '160')
	replies[0]('<result>ok</result>')
	await first
	assert.equal(self.values.setting_iso, '160')
	assert.equal(self.isoStepsInFlight, null)
})

test('mixed unbuffered ISO presses reserve targets in press order and do not wrap', async () => {
	const self = instance()
	self.data.settingChoices.iso = ['100', '125', '160'].map((id) => ({ id, label: id }))
	self.data.settings.iso = '100'
	const replies = []
	self.sendCommand = async (query) => {
		self.commands.push(query)
		return new Promise((resolve) => replies.push(resolve))
	}
	const presses = [1, 1, 1, -1].map((direction) => self.stepIso(direction))
	assert.deepEqual(
		self.commands.map((query) => query.split('value=')[1]),
		['125', '160', '125'],
	)
	replies.forEach((resolve) => resolve('<result>ok</result>'))
	await Promise.all(presses)
	assert.equal(self.values.setting_iso, '125')
	self.data.settings.iso = 'Unknown'
	await assert.rejects(self.stepIso(1), /Current ISO is unknown/)
	assert.equal(self.commands.length, 3)
	self.data.settings.iso = 'auto'
	await assert.rejects(self.stepIso(1), /manual ISO/)
})

test('failed or retired unbuffered ISO replies never replay or overwrite the new session', async () => {
	for (const retired of [false, true]) {
		const self = instance()
		self.data.settingChoices.iso = ['100', '125', '160'].map((id) => ({ id, label: id }))
		self.data.settings.iso = '100'
		const replies = []
		self.sendCommand = async (query) => {
			self.commands.push(query)
			return new Promise((resolve, reject) => replies.push({ resolve, reject }))
		}
		const presses = Promise.allSettled([self.stepIso(1), self.stepIso(1)])
		assert.equal(self.commands.length, 2)
		if (retired) {
			self.camera = {}
			self.storeSetting('iso', '800')
			replies[0].resolve('<result>ok</result>')
		} else {
			replies[0].reject(new Error('timeout'))
			await new Promise((resolve) => setImmediate(resolve))
			await assert.rejects(self.stepIso(-1), /uncertain/)
		}
		replies[1].resolve('<result>ok</result>')
		const results = await presses
		assert.ok(results.every((result) => result.status === 'rejected'))
		assert.equal(self.commands.length, 2)
		assert.equal(self.isoStepsInFlight, null)
		assert.equal(self.values.setting_iso, retired ? '800' : 'Unknown')
	}
})

test('setting controls encode values and update only after acceptance, without extra requests', async () => {
	const self = instance()
	await self.setCameraSetting('colormode', 'v&log')
	assert.deepEqual(self.commands, ['mode=setsetting&type=colormode&value=v%26log'])
	assert.equal(self.values.setting_colormode, 'v&log')
	await assert.rejects(self.setCameraSetting('playmode', 'play'), /Unsupported setting/)
	await assert.rejects(self.setCameraSetting('iso', ''), /Select a value/)
	self.sendCommand = async () => {
		throw new Error('err_busy')
	}
	await assert.rejects(self.setCameraSetting('iso', '800'), /err_busy/)
	assert.equal(self.data.settings.iso, undefined)
})

test('manual information read refreshes dropdowns without exposing modes or photo controls', async () => {
	const self = instance()
	self.sendCommand = async (query) => {
		self.commands.push(query)
		return '<result>ok</result><item cmd_mode="setsetting" cmd_type="iso" cmd_value="800"/>'
	}
	await self.readCameraInfo('allmenu')
	assert.deepEqual(self.commands, ['mode=getinfo&type=allmenu'])
	assert.ok(self.actions.set_iso.options[0].choices.some((choice) => choice.id === '800'))
	assert.equal(self.actions.playmode, undefined)
	assert.equal(self.actions.capture, undefined)
	assert.equal(self.actions.startstream, undefined)
	assert.equal(self.actions.recordingStart.name, 'Video Record Start')
	assert.equal(Object.keys(self.actions).length, 16)
})

test('information downloads share one pending request, use a 60s menu budget, and ignore retired replies', async () => {
	const self = instance()
	let finish
	const options = []
	self.sendCommand = async (query, requestOptions) => {
		self.commands.push(query)
		options.push(requestOptions)
		return new Promise((resolve) => {
			finish = resolve
		})
	}
	const first = self.readCameraInfo('allmenu')
	const second = self.readCameraInfo('allmenu')
	assert.equal(self.commands.length, 1)
	assert.deepEqual(options[0], { timeout: 60000, informational: true })
	finish('<result>ok</result><item cmd_mode="setsetting" cmd_type="iso" cmd_value="800"/>')
	await Promise.all([first, second])
	assert.equal(self.logs.filter((entry) => entry.message.includes('Read available settings:')).length, 1)
	const retired = self.readCameraInfo('allmenu')
	self.camera = {}
	finish('<result>ok</result><item cmd_mode="setsetting" cmd_type="iso" cmd_value="400"/>')
	await retired
	assert.deepEqual(self.data.settingChoices.iso, [{ id: '800', label: '800' }])
	self.sendCommand = async () => {
		throw new Error('deadline exceeded')
	}
	await assert.rejects(self.readCameraInfo('allmenu'), /deadline/)
	self.sendCommand = async () => '<result>ok</result>'
	await self.readCameraInfo('allmenu')
})

test('connection fetches menu once per client in background without blocking polling or retrying failed info', async () => {
	const self = instance()
	self.config = { host: 'camera.test', enableStatePolling: true, interval: 4500 }
	self.camera.connect = async () => ({ modelName: 'S5M2X' })
	self.updateStatus = () => {}
	self.pollCameraState = async () => {}
	let polling = 0
	self.startPolling = () => {
		polling++
	}
	self.stopAfterBusy = () => false
	self.reconnectAfterCritical = () => false
	self.scheduleReconnect = () => {
		throw new Error('Menu failure must not retry pairing')
	}
	let rejectMenu
	self.sendCommand = async (query) => {
		self.commands.push(query)
		return new Promise((_resolve, reject) => {
			rejectMenu = reject
		})
	}
	await LumixInstance.prototype.connectCamera.call(self)
	assert.equal(polling, 1)
	assert.deepEqual(self.commands, ['mode=getinfo&type=allmenu'])
	await LumixInstance.prototype.connectCamera.call(self)
	assert.equal(self.commands.length, 1)
	rejectMenu(new Error('deadline exceeded'))
	await new Promise((resolve) => setImmediate(resolve))
	assert.ok(self.logs.some((entry) => entry.message.includes('Initial available-settings read failed')))
	self.camera = { connect: async () => ({ modelName: 'S5M2X' }) }
	self.sendCommand = async (query) => {
		self.commands.push(query)
		return '<result>ok</result>'
	}
	await LumixInstance.prototype.connectCamera.call(self)
	assert.equal(self.commands.length, 2)
})

test('menu read timeout does not mark a healthy session disconnected and recording retains default timeout', async () => {
	const self = instance()
	self.config = {}
	self.updateStatus = () => {
		throw new Error('Optional info failure must not change status')
	}
	self.stopAfterBusy = () => false
	self.reconnectAfterCritical = () => false
	self.camera.command = async (_query, retry, timeout) => {
		assert.equal(retry, true)
		assert.equal(timeout, 60000)
		throw new Error('deadline exceeded')
	}
	await assert.rejects(
		LumixInstance.prototype.sendCommand.call(self, 'mode=getinfo&type=allmenu', {
			timeout: 60000,
			informational: true,
		}),
		/deadline/,
	)
	self.updateStatus = () => {}
	self.camera.command = async (_query, _retry, timeout) => {
		assert.equal(timeout, undefined)
		return '<result>ok</result>'
	}
	await LumixInstance.prototype.sendCommand.call(self, 'mode=camcmd&value=video_recstart')
})

test('manual setting reads reject missing values and ignore retired-client replies', async () => {
	const self = instance()
	self.sendCommand = async () => '<result>ok</result><settingvalue iso="400"/>'
	await self.readCameraSetting('iso')
	assert.equal(self.values.setting_iso, '400')
	self.sendCommand = async () => '<result>ok</result>'
	await assert.rejects(self.readCameraSetting('iso'), /no recognized value/)
	self.sendCommand = async () => {
		self.camera = {}
		return '<settingvalue iso="800"/>'
	}
	await self.readCameraSetting('iso')
	assert.equal(self.values.setting_iso, '400')
})

test('ISO heartbeat updates only ISO and never treats ISO as camera state', async () => {
	const self = instance()
	self.config = { enableStatePolling: true, interval: 4500, host: 'camera.test' }
	self.consecutivePollErrors = 0
	self.updateStatus = () => {}
	self.setRecordingState = () => {
		throw new Error('ISO is not recording state')
	}
	self.camera.heartbeat = async () => '<result>ok</result><settingvalue iso="640"/>'
	await LumixInstance.prototype.pollCameraState.call(self)
	assert.equal(self.values.setting_iso, '640')
	assert.equal(self.values.setting_focal, undefined)
	assert.equal(self.data.lastStateAt, 0)
	assert.deepEqual(self.data.telemetry, {})
	assert.equal(self.commands.length, 0)
	self.stopAfterBusy = () => false
	self.reconnectAfterCritical = () => false
	self.camera.heartbeat = async () => '<result>ok</result>'
	await LumixInstance.prototype.pollCameraState.call(self)
	assert.equal(self.values.setting_iso, 'Unknown')
	assert.equal(self.consecutivePollErrors, 1)
})

test('feedbacks distinguish unknown data, battery scale, card states, and stale state', () => {
	const self = instance()
	feedbacks(self)
	variables(self)
	self.updateCameraTelemetry(
		'<state><batt>1/5</batt><batt_per>-1</batt_per><cammode>rec</cammode><temperature>high</temperature><sd_full>true</sd_full></state>',
	)
	assert.equal(self.feedbacks.batteryLow.callback({ options: { scale: 'level', threshold: 1 } }), true)
	assert.equal(self.feedbacks.batteryLow.callback({ options: { scale: 'percent', threshold: 20 } }), false)
	assert.equal(self.feedbacks.cardStatus.callback({ options: { slot: '1', condition: 'full' } }), true)
	assert.equal(self.feedbacks.cardStatus.callback({ options: { slot: '2', condition: 'full' } }), false)
	assert.equal(self.feedbacks.cameraMode.callback({ options: { value: 'rec' } }), true)
	assert.equal(self.feedbacks.stateFresh.callback({ options: { seconds: 15 } }), true)
	self.data.lastStateAt -= 16000
	assert.equal(self.feedbacks.stateFresh.callback({ options: { seconds: 15 } }), false)
	self.data.lastStateAt = Date.now()
	self.camera._closed = true
	assert.equal(self.feedbacks.stateFresh.callback({ options: { seconds: 15 } }), false)
	assert.ok(SETTINGS.every((setting) => self.variables['setting_' + setting.id]))
	self.data.telemetry.battery_level = '-1/0'
	assert.equal(self.feedbacks.batteryLow.callback({ options: { scale: 'level', threshold: 1 } }), false)
})
