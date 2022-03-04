module.exports = {
	setPresets: function (i) {
		let self = i
		let presets = []

		const foregroundColor = self.rgb(255, 255, 255) // White
		const backgroundColorRed = self.rgb(255, 0, 0) // Red
		const backgroundColorGreen = self.rgb(0, 255, 0) // Green
		const backgroundColorOrange = self.rgb(255, 102, 0) // Orange

		presets.push({
			category: 'Recording',
			label: 'Start Video Recording',
			bank: {
				style: 'text',
				text: 'Start\\nRecording',
				size: '14',
				color: '16777215',
				bgcolor: self.rgb(0, 0, 0),
			},
			actions: [
				{
					action: 'recordingStart'
				}
			],
			feedbacks: [
				{
					type: 'recordingState',
					options: {
						option: '1',
					},
					style: {
						color: foregroundColor,
						bgcolor: backgroundColorRed,
					}
				}
			]
		})

		presets.push({
			category: 'Recording',
			label: 'Stop Video Recording',
			bank: {
				style: 'text',
				text: 'Stop\\nRecording',
				size: '14',
				color: '16777215',
				bgcolor: self.rgb(0, 0, 0),
			},
			actions: [
				{
					action: 'recordingStop'
				}
			],
			feedbacks: [
				{
					type: 'recordingState',
					options: {
						option: '0',
					},
					style: {
						color: foregroundColor,
						bgcolor: backgroundColorRed,
					}
				}
			]
		})

		return presets
	}
}
