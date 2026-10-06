const { SETTINGS } = require('./settings')

module.exports = function UpdateActions(self) {
	// Each button press starts independently; return to Companion immediately.
	function sendRecording(command, recordingState) {
		const camera = self.camera
		;(async function () {
			await self.sendCommand(command)
			if (camera !== self.camera) return
			self.setRecordingState(recordingState)
			self.log('info', 'Recording ' + (recordingState ? 'start' : 'stop') + ' confirmed by camera')
		})().catch(function (error) {
			self.log('error', 'Recording action failed: ' + error.message)
		})
	}

	const definitions = {
		recordingStart: {
			name: 'Video Record Start',
			options: [],
			callback: function () {
				// Shooting mode is established during pairing, not on each button press.
				sendRecording('mode=camcmd&value=video_recstart', true)
			},
		},
		recordingStop: {
			name: 'Video Record Stop',
			options: [],
			callback: function () {
				sendRecording('mode=camcmd&value=video_recstop', false)
			},
		},
	}
	function background(operation) {
		Promise.resolve()
			.then(operation)
			.catch((error) => self.log('error', 'Camera action failed: ' + error.message))
	}
	for (const setting of SETTINGS) {
		const choices = (self.data && self.data.settingChoices && self.data.settingChoices[setting.id]) || []
		definitions['set_' + setting.id] = {
			name: 'Set ' + setting.name + ' (Experimental)',
			options: [
				{
					type: 'dropdown',
					id: 'value',
					label: 'Camera value (read available settings first)',
					default: '',
					allowCustom: true,
					choices: [{ id: '', label: 'Select a camera-reported value or enter its protocol value' }, ...choices],
				},
			],
			callback: (action) => background(() => self.setCameraSetting(setting.id, action.options.value)),
		}
	}
	for (const [id, name, direction] of [
		['isoIncrease', 'ISO Increase (Next Value / 1/3 Stop)', 1],
		['isoDecrease', 'ISO Decrease (Previous Value / 1/3 Stop)', -1],
	]) {
		definitions[id] = {
			name,
			options: [],
			callback: () => background(() => self.stepIso(direction)),
		}
	}
	definitions.readSetting = {
		name: 'Read Current Setting',
		options: [
			{
				type: 'dropdown',
				id: 'setting',
				label: 'Setting',
				default: 'iso',
				choices: SETTINGS.map((s) => ({ id: s.id, label: s.name })),
			},
		],
		callback: (action) => background(() => self.readCameraSetting(action.options.setting)),
	}
	definitions.cameraInfo = {
		name: 'Read Camera Information / Available Settings',
		options: [
			{
				type: 'dropdown',
				id: 'type',
				label: 'Information',
				default: 'allmenu',
				choices: [
					{ id: 'allmenu', label: 'Available settings (populate action choices)' },
					{ id: 'curmenu', label: 'Current menu' },
					{ id: 'capability', label: 'Capabilities' },
					{ id: 'lens', label: 'Lens information' },
				],
			},
		],
		callback: (action) => background(() => self.readCameraInfo(action.options.type)),
	}
	self.setActionDefinitions(definitions)
}
