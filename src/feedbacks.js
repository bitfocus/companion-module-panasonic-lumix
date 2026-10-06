const { combineRgb } = require('@companion-module/base')
const { SETTINGS } = require('./settings')

module.exports = function UpdateFeedbacks(self) {
	const definitions = {
		recordingState: {
			type: 'boolean',
			name: 'Recording State',
			description: 'Indicate whether the camera is recording or stopped',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(255, 0, 0),
			},
			options: [
				{
					type: 'dropdown',
					label: 'State',
					id: 'state',
					default: 'recording',
					choices: [
						{ id: 'stopped', label: 'Stopped' },
						{ id: 'recording', label: 'Recording' },
					],
				},
			],
			callback: function (feedback) {
				return feedback.options.state === 'recording' ? self.data.recordingState : !self.data.recordingState
			},
		},
	}
	const style = { color: combineRgb(255, 255, 255), bgcolor: combineRgb(255, 128, 0) }
	const telemetry = () => self.data.telemetry || {}
	definitions.batteryLow = {
		type: 'boolean',
		name: 'Battery Low',
		defaultStyle: style,
		options: [
			{
				type: 'dropdown',
				id: 'scale',
				label: 'Scale',
				default: 'level',
				choices: [
					{ id: 'level', label: 'Camera level (0–5)' },
					{ id: 'percent', label: 'Percentage (only when reported)' },
				],
			},
			{ type: 'number', id: 'threshold', label: 'At or below', default: 1, min: 0, max: 100 },
		],
		callback: (feedback) => {
			const level = /^([0-5])\/5$/.exec(telemetry().battery_level || '')
			const value = feedback.options.scale === 'percent' ? telemetry().battery_percent : level ? level[1] : 'Unknown'
			return (
				value !== '' &&
				value !== undefined &&
				value !== 'Unknown' &&
				Number.isFinite(Number(value)) &&
				Number(value) <= Number(feedback.options.threshold)
			)
		},
	}
	for (const [id, name, field, choices] of [
		['cameraMode', 'Camera Mode (Read-only)', 'camera_mode', ['rec', 'play']],
		['temperature', 'Temperature Status', 'temperature', ['low', 'high']],
	]) {
		definitions[id] = {
			type: 'boolean',
			name,
			defaultStyle: style,
			options: [
				{
					type: 'dropdown',
					id: 'value',
					label: 'Camera value',
					default: choices[0],
					allowCustom: true,
					choices: choices.map((value) => ({ id: value, label: value })),
				},
			],
			callback: (feedback) => telemetry()[field] !== 'Unknown' && telemetry()[field] === feedback.options.value,
		}
	}
	definitions.cardStatus = {
		type: 'boolean',
		name: 'Card Status',
		defaultStyle: style,
		options: [
			{
				type: 'dropdown',
				id: 'slot',
				label: 'Slot',
				default: '1',
				choices: [
					{ id: '1', label: 'Card 1' },
					{ id: '2', label: 'Card 2' },
				],
			},
			{
				type: 'dropdown',
				id: 'condition',
				label: 'Condition',
				default: 'full',
				choices: [
					{ id: 'full', label: 'Full' },
					{ id: 'writable', label: 'Writable' },
					{ id: 'access', label: 'Being accessed' },
				],
			},
		],
		callback: (feedback) => {
			const slot = feedback.options.slot === '2' ? '2' : '1'
			const fields = { full: ['full', 'true'], writable: ['status', 'write_enable'], access: ['access', 'on'] }
			const condition = fields[feedback.options.condition]
			return Boolean(condition && telemetry()['card' + slot + '_' + condition[0]] === condition[1])
		},
	}
	definitions.stateFresh = {
		type: 'boolean',
		name: 'Recent State Reply',
		defaultStyle: { ...style, bgcolor: combineRgb(0, 128, 0) },
		options: [
			{ type: 'number', id: 'seconds', label: 'Received within this many seconds', default: 15, min: 1, max: 3600 },
		],
		callback: (feedback) =>
			Boolean(
				self.camera &&
				!self.camera._closed &&
				self.data.lastStateAt &&
				Date.now() - self.data.lastStateAt <= Number(feedback.options.seconds) * 1000,
			),
	}
	definitions.settingValue = {
		type: 'boolean',
		name: 'Setting Value (Last Read / Accepted)',
		defaultStyle: style,
		options: [
			{
				type: 'dropdown',
				id: 'setting',
				label: 'Setting',
				default: 'iso',
				choices: SETTINGS.map((s) => ({ id: s.id, label: s.name })),
			},
			{ type: 'textinput', id: 'value', label: 'Protocol value', default: '' },
		],
		callback: (feedback) =>
			Boolean(
				feedback.options.value &&
				self.data.settings &&
				self.data.settings[feedback.options.setting] === feedback.options.value,
			),
	}
	self.setFeedbackDefinitions(definitions)
}
