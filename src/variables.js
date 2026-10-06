const { SETTINGS } = require('./settings')

module.exports = function UpdateVariableDefinitions(self) {
	const definitions = {
		recording_state: { name: 'Recording State' },
		camera_model: { name: 'Camera Model' },
		battery_level: { name: 'Battery Level (camera scale)' },
		battery_percent: { name: 'Battery Percentage (Unknown if unavailable)' },
		camera_mode: { name: 'Camera Mode (read-only)' },
		video_remaining: { name: 'Remaining Recording Capacity (raw camera value)' },
		recording_elapsed: { name: 'Recording Progress Time (raw camera value)' },
		temperature: { name: 'Temperature Status' },
		card1_status: { name: 'Card 1 Status' },
		card2_status: { name: 'Card 2 Status' },
		card1_full: { name: 'Card 1 Full' },
		card2_full: { name: 'Card 2 Full' },
		card1_access: { name: 'Card 1 Activity' },
		card2_access: { name: 'Card 2 Activity' },
		active_card: { name: 'Active Card' },
		warning_display: { name: 'Camera Warning Display' },
		last_state_received: { name: 'Last Successful State Reply (UTC)' },
		last_info_type: { name: 'Last Information Request' },
		last_info_xml: { name: 'Last Information Reply XML (up to 4096 characters)' },
	}
	for (const setting of SETTINGS)
		definitions['setting_' + setting.id] = { name: setting.name + ' (last read or accepted protocol value)' }
	self.setVariableDefinitions(definitions)
}
