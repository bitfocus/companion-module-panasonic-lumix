const { tagValue } = require('./camera-client')

// Protocol request types mapped by njfdev/liblumix. Values are camera-dependent.
const SETTINGS = [
	{ id: 'iso', name: 'ISO' },
	{ id: 'focal', name: 'Aperture' },
	{ id: 'shtrspeed', name: 'Shutter Speed' },
	{ id: 'exposure', name: 'Exposure Compensation' },
	{ id: 'focusmode', name: 'Focus Mode' },
	{ id: 'lightmetering', name: 'Metering Mode' },
	{ id: 'peaking', name: 'Focus Peaking' },
	{ id: 'filter_setting', name: 'Filter' },
	{ id: 'colormode', name: 'Colour Mode / Photo Style' },
	{ id: 'videoquality', name: 'Video Quality' },
]

function decodeXml(value) {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
		const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
		if (named[entity]) return named[entity]
		const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
		return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
	})
}

function attributes(text) {
	const result = Object.create(null)
	for (const match of text.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) result[match[1]] = decodeXml(match[3])
	return result
}

function parseMenuChoices(xml) {
	const titles = Object.create(null)
	const english = /<language\b[^>]*code=["']en["'][^>]*>([\s\S]*?)<\/language>/i.exec(xml)
	for (const match of (english ? english[1] : xml).matchAll(/<title\b([^>]*)>([^<]*)<\/title>/gi)) {
		const attr = attributes(match[1])
		if (attr.id && !titles[attr.id]) titles[attr.id] = decodeXml(match[2])
	}
	const result = Object.create(null)
	for (const setting of SETTINGS) result[setting.id] = []
	for (const match of xml.matchAll(/<item\b([^>]*)>/gi)) {
		const attr = attributes(match[1])
		if (attr.cmd_mode !== 'setsetting' || !result[attr.cmd_type] || !attr.cmd_value) continue
		// Dynamic placeholders and multi-value commands need additional UI; do not guess them.
		if (/__/.test(attr.cmd_value) || attr.cmd_value2 || attr.cmd_value3) continue
		const choices = result[attr.cmd_type]
		if (!choices.some((choice) => choice.id === attr.cmd_value)) {
			choices.push({ id: attr.cmd_value, label: titles[attr.title_id] || attr.cmd_value })
		}
	}
	return result
}

function nextIsoChoice(choices, current, direction) {
	if (direction !== 1 && direction !== -1) throw new Error('ISO direction must be up or down')
	const numeric = (choices || [])
		.filter((choice) => /^\d+$/.test(choice.id) && Number(choice.id) > 0 && Number.isFinite(Number(choice.id)))
		.slice()
		.sort((a, b) => Number(a.id) - Number(b.id))
	if (!numeric.length)
		throw new Error('Available ISO choices are not loaded; wait for the menu or read available settings')
	if (!/^\d+$/.test(String(current)) || Number(current) <= 0 || !Number.isFinite(Number(current)))
		throw new Error('ISO stepping requires a numeric current ISO; select a manual ISO instead of Auto')
	const ordered = direction === 1 ? numeric : numeric.slice().reverse()
	const next = ordered.find((choice) =>
		direction === 1 ? Number(choice.id) > Number(current) : Number(choice.id) < Number(current),
	)
	return next ? next.id : null
}

function parseSettingValue(xml, type) {
	const node = /<settingvalue\b([^>]*)>/i.exec(xml)
	const attr = node ? attributes(node[1]) : {}
	return attr[type] !== undefined ? attr[type] : tagValue(xml, type) || null
}

const STATE_FIELDS = {
	battery_level: 'batt',
	battery_percent: 'batt_per',
	camera_mode: 'cammode',
	video_remaining: 'video_remaincapacity',
	recording_elapsed: 'progress_time',
	temperature: 'temperature',
	card1_status: 'sdcardstatus',
	card2_status: 'sd2_cardstatus',
	card1_full: 'sd_full',
	card2_full: 'sd2_full',
	active_card: 'current_sd',
	card1_access: 'sd_access',
	card2_access: 'sd2_access',
	warning_display: 'warn_disp',
}

function parseTelemetry(xml) {
	const values = {}
	for (const [id, tag] of Object.entries(STATE_FIELDS)) {
		const value = tagValue(xml, tag)
		values[id] = value || 'Unknown'
	}
	const percent = Number(values.battery_percent)
	if (!Number.isFinite(percent) || percent < 0 || percent > 100) values.battery_percent = 'Unknown'
	return values
}

module.exports = { SETTINGS, STATE_FIELDS, parseMenuChoices, parseSettingValue, parseTelemetry, nextIsoChoice }
