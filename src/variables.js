module.exports = {
	// ##########################
	// #### Define Variables ####
	// ##########################
	setVariables: function (i) {
		let self = i
		let variables = []

		variables.push({ name: 'recording_state', label: 'Recording State' })

		return variables
	},

	// #########################
	// #### Check Variables ####
	// #########################
	checkVariables: function (i) {
		let self = i;

		try {
			self.setVariable('recording_state', ( self.data.recordingState ? 'Recording' : 'Stopped'));
		}
		catch(error) {
			self.log('error', 'Error parsing Variables from Camera: ' + String(error))
		}
	}
}