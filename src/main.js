const { InstanceBase, InstanceStatus, Regex } = require('@companion-module/base')
const { LumixCameraClient } = require('./camera-client')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariableDefinitions = require('./variables')
const UpgradeScripts = require('./upgrades')
const {
	SETTINGS,
	STATE_FIELDS,
	parseMenuChoices,
	parseSettingValue,
	parseTelemetry,
	nextIsoChoice,
} = require('./settings')

class LumixInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.camera = null
		this.pollTimer = null
		this.reconnectTimer = null
		this.feedbackTimer = null
		this.consecutivePollErrors = 0
		this.data = {
			recordingState: false,
			cameraInfo: null,
			telemetry: {},
			settings: {},
			settingChoices: {},
			lastStateAt: 0,
		}
	}

	async init(config) {
		this.config = this.normalizeConfig(config)
		this.updateDefinitions()
		this.createCameraClient()
		// Re-evaluate age locally; this timer never sends requests to the camera.
		this.feedbackTimer = setInterval(() => this.checkFeedbacks('stateFresh'), 1000)
		this.connectCamera()
	}

	async destroy() {
		if (this.feedbackTimer) clearInterval(this.feedbackTimer)
		this.feedbackTimer = null
		this.stopPolling()
		if (this.camera) this.camera.disconnect()
		this.log('debug', 'Lumix module destroyed')
	}

	async configUpdated(config) {
		this.stopPolling()
		if (this.camera) this.camera.disconnect()
		this.config = this.normalizeConfig(config)
		this.createCameraClient()
		this.connectCamera()
	}

	normalizeConfig(config) {
		return {
			host: (config && config.host) || '',
			// Start the new getstate test at 1s, without inheriting the old PA interval.
			interval:
				config && config.enableStatePolling !== undefined && config.interval !== undefined
					? Number(config.interval)
					: 1000,
			controllerName: (config && config.controllerName) || 'Bitfocus Companion',
			debug: Boolean(config && config.debug),
			enableStatePolling:
				!config || config.enableStatePolling === undefined ? true : Boolean(config.enableStatePolling),
		}
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'Controls Panasonic Lumix cameras over Wi-Fi, including the S5II and S5IIX session handshake.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Camera IP',
				width: 6,
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'controllerName',
				label: 'Controller Name',
				width: 6,
				default: 'Bitfocus Companion',
			},
			{
				type: 'checkbox',
				id: 'enableStatePolling',
				label: 'Enable ISO Heartbeat (Session Maintenance Test)',
				width: 12,
				default: true,
			},
			{
				type: 'number',
				id: 'interval',
				label: 'Heartbeat Interval (ms)',
				width: 6,
				default: 1000,
				min: 0,
				max: 60000,
			},
			{
				type: 'checkbox',
				id: 'debug',
				label: 'Log Every Camera Request and Response',
				width: 6,
				default: false,
			},
		]
	}

	updateDefinitions() {
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)
		this.setVariableValues({
			recording_state: this.data.recordingState ? 'Recording' : 'Stopped',
			camera_model: this.data.cameraInfo ? this.data.cameraInfo.modelName || '' : '',
		})
	}

	createCameraClient() {
		this.data.telemetry = {}
		this.data.settings = {}
		this.data.settingChoices = {}
		this.data.lastStateAt = 0
		this.setVariableValues(
			Object.fromEntries([
				...Object.keys(STATE_FIELDS).map((id) => [id, 'Unknown']),
				...SETTINGS.map((setting) => ['setting_' + setting.id, 'Unknown']),
				['last_state_received', 'Unknown'],
				['last_info_type', 'Unknown'],
				['last_info_xml', ''],
			]),
		)
		UpdateActions(this)
		this.checkFeedbacks('batteryLow', 'cameraMode', 'temperature', 'cardStatus', 'stateFresh', 'settingValue')
		this.camera = new LumixCameraClient({
			host: this.config.host,
			controllerName: this.config.controllerName,
			log: (message) => {
				if (this.config.debug) this.log('info', message)
			},
		})
	}

	async connectCamera() {
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Camera IP is required')
			return
		}

		const camera = this.camera
		try {
			this.updateStatus(InstanceStatus.Connecting, 'Requesting camera access')
			const cameraInfo = await camera.connect()
			if (camera !== this.camera) return
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
			this.data.cameraInfo = cameraInfo
			this.consecutivePollErrors = 0
			this.setVariableValues({ camera_model: cameraInfo.modelName || '' })
			this.updateStatus(InstanceStatus.Ok)
			this.log('info', 'Connected to ' + (cameraInfo.modelName || 'Lumix camera'))
			this.log(
				'info',
				this.config.enableStatePolling && this.config.interval > 0
					? 'ISO-only session-maintenance test enabled; interval=' +
							Math.max(1000, this.config.interval) +
							'ms; getstate, PA and other automatic settings requests disabled'
					: 'ISO heartbeat disabled; status reflects last successful request, not a live connection check',
			)
			await this.pollCameraState()
			if (camera === this.camera && !camera.safetyStopped && !camera._closed) {
				this.startPolling()
				// One background menu download per client/session. Do not delay the
				// heartbeat or retry pairing merely because this optional read fails.
				if (!this.menuRequestedClients) this.menuRequestedClients = new WeakSet()
				if (!this.menuRequestedClients.has(camera)) {
					this.menuRequestedClients.add(camera)
					this.readCameraInfo('allmenu').catch((error) => {
						if (camera === this.camera) this.log('warn', 'Initial available-settings read failed: ' + error.message)
					})
				}
			}
		} catch (error) {
			if (camera !== this.camera) return
			if (this.stopAfterBusy(error, camera)) return
			if (this.reconnectAfterCritical(error, camera)) return
			this.updateStatus(InstanceStatus.ConnectionFailure, error.message)
			this.log('error', 'Unable to connect to camera: ' + error.message)
			this.scheduleReconnect()
		}
	}

	stopAfterBusy(error, camera) {
		if (camera !== this.camera || !camera.safetyStopped) return false
		this.stopPolling()
		this.updateStatus(
			InstanceStatus.ConnectionFailure,
			'Camera busy: traffic stopped. Recover camera and restart module.',
		)
		this.checkFeedbacks('stateFresh')
		if (!camera.busyWarningLogged) {
			camera.busyWarningLogged = true
			this.log(
				'error',
				'Camera safety stop after 3 consecutive err_busy heartbeats: polling and automatic reconnect disabled. Recover camera, then disable/enable this module.',
			)
		}
		return true
	}

	reconnectAfterCritical(error, camera) {
		if (camera.safetyStopped) return false
		if (error.cameraResult !== 'err_critical' || camera !== this.camera) return false
		this.log('warn', 'Camera returned err_critical; reconnecting immediately (recording command will not be replayed)')
		this.stopPolling()
		camera.disconnect()
		this.createCameraClient()
		this.consecutivePollErrors = 0
		this.connectCamera()
		return true
	}

	scheduleReconnect() {
		if (this.camera.safetyStopped || this.reconnectTimer || !this.config.host || this.config.interval <= 0) return
		const retryDelay = Math.max(5000, this.config.interval)
		const camera = this.camera
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (camera !== this.camera || (camera.sessionId && !camera._connecting)) return
			this.connectCamera()
		}, retryDelay)
	}

	startPolling() {
		this.stopPolling()
		if (this.config.enableStatePolling && this.config.interval > 0) {
			this.pollTimer = setInterval(() => this.pollCameraState(), Math.max(1000, this.config.interval))
		}
	}

	stopPolling() {
		if (this.pollTimer) clearInterval(this.pollTimer)
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.pollTimer = null
		this.reconnectTimer = null
	}

	async pollCameraState() {
		if (
			!this.config.enableStatePolling ||
			this.config.interval <= 0 ||
			!this.camera ||
			this.camera.safetyStopped ||
			!this.config.host
		)
			return
		const camera = this.camera
		try {
			const xml = await camera.heartbeat()
			if (camera !== this.camera || xml === null) return
			const value = parseSettingValue(xml, 'iso')
			if (value === null) {
				this.storeSetting('iso', 'Unknown')
				throw new Error('ISO heartbeat returned no recognized ISO value')
			}
			this.storeSetting('iso', value)
			this.consecutivePollErrors = 0
			this.updateStatus(InstanceStatus.Ok)
		} catch (error) {
			if (camera === this.camera) {
				if (this.stopAfterBusy(error, camera)) return
				if (this.reconnectAfterCritical(error, camera)) return
				this.consecutivePollErrors += 1
				this.updateStatus(InstanceStatus.UnknownWarning, 'Heartbeat unavailable; camera connection unverified')
				if (this.consecutivePollErrors === 1) {
					this.log('warn', 'Camera heartbeat missed: ' + error.message)
				} else if (this.config.debug) {
					this.log('debug', 'Camera state poll failed: ' + error.message)
				}
			}
		}
	}

	async sendCommand(command, options = {}) {
		if (!this.camera) throw new Error('Camera client is not initialized')
		const camera = this.camera
		if (this.config.debug) this.log('debug', 'Send CMD: ' + command)
		try {
			const response = await camera.command(command, true, options.timeout)
			if (camera !== this.camera) throw new Error('Camera connection changed during command')
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
			this.consecutivePollErrors = 0
			this.updateStatus(InstanceStatus.Ok)
			return response
		} catch (error) {
			if (camera !== this.camera) throw error
			if (this.stopAfterBusy(error, camera)) throw error
			if (this.reconnectAfterCritical(error, camera)) throw error
			if (!options.informational) this.updateStatus(InstanceStatus.ConnectionFailure, error.message)
			this.log(options.informational ? 'warn' : 'error', 'Camera command failed: ' + error.message)
			throw error
		}
	}

	updateCameraTelemetry(xml) {
		this.data.telemetry = parseTelemetry(xml)
		this.data.lastStateAt = Date.now()
		this.setVariableValues({
			...this.data.telemetry,
			last_state_received: new Date(this.data.lastStateAt).toISOString(),
		})
		this.checkFeedbacks('batteryLow', 'cameraMode', 'temperature', 'cardStatus', 'stateFresh', 'settingValue')
	}

	async setCameraSetting(type, value) {
		if (!SETTINGS.some((setting) => setting.id === type)) throw new Error('Unsupported setting')
		value = String(value === undefined ? '' : value).trim()
		if (!value || value.length > 128 || /[\u0000-\u001f]|__/.test(value))
			throw new Error('Select a value reported by the camera, or enter a valid protocol value')
		const camera = this.camera
		await this.sendCommand('mode=setsetting&type=' + encodeURIComponent(type) + '&value=' + encodeURIComponent(value))
		if (camera !== this.camera) return
		this.storeSetting(type, value)
		this.log('info', 'Camera accepted ' + type + '=' + value)
	}

	async stepIso(direction) {
		if (direction !== 1 && direction !== -1) throw new Error('ISO direction must be up or down')
		const camera = this.camera
		if (!camera || camera._closed || camera.safetyStopped)
			throw new Error('Camera connection is unavailable for ISO stepping')
		let state = this.isoStepsInFlight
		if (!state || state.camera !== camera)
			state = { camera, requested: this.data.settings.iso, pending: 0, sequence: 0, acceptedSequence: 0, failed: false }
		if (state.failed)
			throw new Error('ISO result is uncertain; wait for outstanding replies and read ISO before stepping again')
		if (!state.requested || state.requested === 'Unknown')
			throw new Error('Current ISO is unknown; wait for the ISO heartbeat or use Read Current Setting before stepping')
		// Reserve the next target synchronously. Every press sends independently,
		// even while older requests or heartbeat replies are still outstanding.
		const next = nextIsoChoice(this.data.settingChoices.iso, state.requested, direction)
		if (next === null) {
			this.log('info', 'ISO is already at the ' + (direction === 1 ? 'highest' : 'lowest') + ' reported value')
			return
		}
		this.isoStepsInFlight = state
		state.requested = next
		const sequence = ++state.sequence
		state.pending++
		try {
			await this.sendCommand('mode=setsetting&type=iso&value=' + encodeURIComponent(next))
			if (camera !== this.camera || camera._closed || camera.safetyStopped)
				throw new Error('Camera connection changed or stopped during ISO set')
			if (state.failed) throw new Error('ISO burst contains a failed request; wait for a fresh ISO read')
			// An older acknowledgment must not overwrite a newer accepted target.
			// Actual application order remains camera-dependent; heartbeat reads reconcile it.
			if (sequence > state.acceptedSequence) {
				state.acceptedSequence = sequence
				this.storeSetting('iso', next)
			}
			this.log('info', 'Camera accepted ISO step target=' + next)
		} catch (error) {
			state.failed = true
			if (camera === this.camera) this.storeSetting('iso', 'Unknown')
			throw error
		} finally {
			state.pending--
			if (!state.pending && this.isoStepsInFlight === state) this.isoStepsInFlight = null
		}
	}

	storeSetting(type, value) {
		this.data.settings[type] = value
		this.setVariableValues({ ['setting_' + type]: value })
		this.checkFeedbacks('settingValue')
	}

	async readCameraSetting(type) {
		if (!SETTINGS.some((setting) => setting.id === type)) throw new Error('Unsupported setting')
		const camera = this.camera
		const xml = await this.sendCommand('mode=getsetting&type=' + encodeURIComponent(type))
		if (camera !== this.camera) return
		const value = parseSettingValue(xml, type)
		if (value === null) throw new Error('Camera returned no recognized value for ' + type)
		this.storeSetting(type, value)
		this.log('info', 'Current camera setting ' + type + '=' + value)
	}

	async readCameraInfo(type) {
		if (!['allmenu', 'curmenu', 'capability', 'lens'].includes(type)) throw new Error('Unsupported information request')
		const camera = this.camera
		if (!camera) throw new Error('Camera client is not initialized')
		if (!this.pendingInfoReads) this.pendingInfoReads = new WeakMap()
		let reads = this.pendingInfoReads.get(camera)
		if (!reads) {
			reads = new Map()
			this.pendingInfoReads.set(camera, reads)
		}
		if (reads.has(type)) return reads.get(type)
		const pending = this.fetchCameraInfo(type, camera)
		reads.set(type, pending)
		try {
			return await pending
		} finally {
			if (reads.get(type) === pending) reads.delete(type)
		}
	}

	async fetchCameraInfo(type, camera) {
		const xml = await this.sendCommand('mode=getinfo&type=' + type, {
			timeout: type === 'allmenu' || type === 'curmenu' ? 60000 : 15000,
			informational: true,
		})
		if (camera !== this.camera) return
		// Keep button variables bounded; the request log contains the complete reply when tracing is enabled.
		this.setVariableValues({
			last_info_type: type,
			last_info_xml: xml.length > 4096 ? xml.slice(0, 4096) + '\n[truncated]' : xml,
		})
		if (type === 'allmenu') {
			this.data.settingChoices = parseMenuChoices(xml)
			UpdateActions(this)
			const count = Object.values(this.data.settingChoices).reduce((sum, choices) => sum + choices.length, 0)
			this.log(
				'info',
				'Read available settings: ' +
					count +
					' single-value choices found. Availability may depend on lens and shooting settings.',
			)
		} else {
			this.log(
				'info',
				'Read camera information: ' +
					type +
					' (' +
					xml.length +
					' characters; see last_info_xml variable or request trace)',
			)
		}
	}

	setRecordingState(recordingState) {
		if (this.data.recordingState === recordingState) return
		this.data.recordingState = recordingState
		this.setVariableValues({ recording_state: recordingState ? 'Recording' : 'Stopped' })
		this.checkFeedbacks('recordingState')
	}
}

module.exports = LumixInstance
module.exports.UpgradeScripts = UpgradeScripts
