module.exports = {
	// ##########################
	// #### Define Feedbacks ####
	// ##########################
	setFeedbacks: function (i) {
		let self = i
		let feedbacks = {}
		
		const foregroundColor = self.rgb(255, 255, 255) // White
		const backgroundColorRed = self.rgb(255, 0, 0) // Red
		const backgroundColorGreen = self.rgb(0, 255, 0) // Green
		const backgroundColorOrange = self.rgb(255, 102, 0) // Orange

		feedbacks.recordingState = {
			type: 'boolean',
			label: 'Recording State',
			description: 'Indicate if Camera is recording',
			style: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Indicate in X State',
					id: 'option',
					default: '1',
					choices: [
						{ id: '0', label: 'Stopped' },
						{ id: '1', label: 'Recording' },
					],
				},
			],
			callback: function (feedback, bank) {
				var opt = feedback.options
				switch (opt.option) {
					case '0':
						if (self.data.recordingState === false) {
							return true
						}
						break
					case '1':
						if (self.data.recordingState === true) {
							return true
						}
						break
					default:
						break
				}
				return false
			}
		}

		return feedbacks
	}
}
