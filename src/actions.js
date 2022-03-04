module.exports = {
	// ##########################
	// #### Instance Actions ####
	// ##########################
	setActions: function (i) {
		let self = i
		let actions = {}
		let cmd = ''

		actions.recordingStart = {
			label: 'Video Record Start',
			callback: function (action, bank) {
				cmd = 'mode=camcmd&value=video_recstart'
				self.sendCommand(cmd);
				self.data.recordingState = true;
			}
		}

		actions.recordingStop = {
			label: 'Video Record Stop',
			callback: function (action, bank) {
				cmd = 'mode=camcmd&value=video_recstop'
				self.sendCommand(cmd);
				self.data.recordingState = false;
			}
		}

		return actions
	}
}
