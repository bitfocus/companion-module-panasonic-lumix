var instance_skel = require('../../../instance_skel')
var actions = require('./actions.js')
var presets = require('./presets.js')
var feedbacks = require('./feedbacks.js')
var variables = require('./variables.js')

var debug

instance.prototype.INTERVAL = null; //used for polling device

// ########################
// #### Instance setup ####
// ########################
function instance(system, id, config) {
	let self = this;

	// super-constructor
	instance_skel.apply(this, arguments)

	return self
}

instance.GetUpgradeScripts = function () {
}

// When module gets deleted
instance.prototype.destroy = function () {
	let self = this;

	if (self.INTERVAL) {
		clearInterval(self.INTERVAL);
		self.INTERVAL = null;
	}

	debug('destroy', self.id)
}

// Initalize module
instance.prototype.init = function () {
	let self = this;

	debug = self.debug
	log = self.log

	self.data = {
		recordingState: false
	}

	self.config.host = this.config.host || ''
	self.config.debug = this.config.debug || false
	self.config.interval = this.config.interval || 5000

	self.status(self.STATUS_WARNING, 'connecting')
	self.getCameraInformation()
	self.setupInterval();
	self.actions() // export actions
	self.init_presets()
	self.init_variables()
	self.checkVariables()
	self.init_feedbacks()
	self.checkFeedbacks()
}

// Update module after a config change
instance.prototype.updateConfig = function (config) {
	let self = this;
	self.config = config
	self.status(self.STATUS_UNKNOWN)
	self.getCameraInformation()
	self.setupInterval();
	self.actions() // export actions
	self.init_presets()
	self.init_variables()
	self.checkVariables()
	self.init_feedbacks()
	self.checkFeedbacks()
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	let self = this;

	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module controls Panasonic Lumix Wifi-Enabled Cameras.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Camera IP',
			width: 4,
			regex: self.REGEX_IP
		},
		{
			type: 'text',
			id: 'dummy1',
			width: 12,
			label: ' ',
			value: ' ',
		},
		{
			type: 'text',
			id: 'intervalInfo',
			width: 12,
			label: 'Update Interval',
			value: 'Please enter the amount of time in milliseconds to request new information from the camera. Set to 0 to disable.',
		},
		{
			type: 'textinput',
			id: 'interval',
			label: 'Update Interval',
			width: 3,
			default: 5000
		},
		{
			type: 'text',
			id: 'dummy2',
			width: 12,
			label: ' ',
			value: ' ',
		},
		{
			type: 'text',
			id: 'Info',
			width: 12,
			label: 'Other Settings',
			value:
				'These setting can be left on the default values and should give you a consistent setup, but they are there for you to use if need be.',
		},
		{
			type: 'checkbox',
			id: 'debug',
			width: 1,
			label: 'Enable',
			default: false,
		},
		{
			type: 'text',
			id: 'debugInfo',
			width: 11,
			label: 'Enable Debug To Log Window',
			value:
				'Requires Companion to be restarted. But this will allow you the see what is being sent from the module and what is being received from the camera.',
		},
	]
}


instance.prototype.getCameraInformation = function () {
	//Get all information from Camera
	let self = this;

	if (self.config.host) {
		self.system.emit(
			'rest_get',
			'http://' + self.config.host + ':' + self.config.httpPort + '/cam.cgi?mode=getinfo&type=setting',
			function (err, result) {
				// If there was an Error
				if (err) {
					let errString = '';
					self.status(self.STATUS_ERROR);
					try {
						if (result && result.error && result.error.code) {
							if (result.error.code === 'ETIMEDOUT') {
								errString = 'Unable to reach device. Timed out.';
							}
							else if (result.error.code === 'ECONNREFUSED') {
								errString = 'Connection refused. Is this the right IP address?';
							}
							else {
								errString = result.error.code.toString();
							}
							self.log('error', 'Error from Camera: ' + errString);	
						}
					}
					catch(error) {
						self.log('error', 'Camera gave an error: ' + error);
					}

					if (self.INTERVAL) {
						self.log('info', 'Stopping Update Interval due to error.');
						clearInterval(self.INTERVAL);
						self.INTERVAL = null;
					}
					
					return
				}

				// If We get a responce, store the values

				self.status(self.STATUS_OK);

				if (('data', result.response.req)) {
					//parsing of the response isn't actually implemented at this time, so don't do anything with whatever was returned for now
					//self.storeData(result.data);

					self.checkVariables()
					self.checkFeedbacks()
				}
			}
		)
	}
};

instance.prototype.getCameraInformation_Delayed = function() {
	let self = this;

	setTimeout(self.getCameraInformation.bind(self), 500);
};

instance.prototype.storeData = function (str) {
	let self = this;

	self.data.info.push(str);

	try {
		// Store Values from Response
	}
	catch(error) {
		self.log('error', 'Error parsing response from Camera: ' + String(error))
	}
};

instance.prototype.setupInterval = function() {
	let self = this;

	if (self.INTERVAL !== null) {
		clearInterval(self.INTERVAL);
		self.INTERVAL = null;
	}

	if (self.config.interval > 0) {
		self.INTERVAL = setInterval(self.getCameraInformation.bind(self), self.config.interval);
	}
};

// ##########################
// #### Instance Presets ####
// ##########################
instance.prototype.init_presets = function () {
	this.setPresetDefinitions(presets.setPresets(this));
}

// ############################
// #### Instance Variables ####
// ############################
instance.prototype.init_variables = function () {
	this.setVariableDefinitions(variables.setVariables(this));
}

// Setup Initial Values
instance.prototype.checkVariables = function () {
	variables.checkVariables(this);
}

// ############################
// #### Instance Feedbacks ####
// ############################
instance.prototype.init_feedbacks = function (system) {
	this.setFeedbackDefinitions(feedbacks.setFeedbacks(this));
}

// ##########################
// #### Instance Actions ####
// ##########################
instance.prototype.sendCommand = function (str) {
	if (str !== undefined) {
		self.system.emit(
			'rest_get',
			'http://' + self.config.host + '/cam.cgi?' + str,
			function (err, result) {
				if (self.config.debug == true) {
					self.debug(
						'http://' + self.config.host + '/cam.cgi?' + str
					)
					self.log('warn', 'Send CMD: ' + String(str))
				}
				try {
					if (result && result.error && result.error.code) {
						if (result.error.code === 'ETIMEDOUT') {
							errString = 'Unable to reach device. Timed out.';
						}
						else if (result.error.code === 'ECONNREFUSED') {
							errString = 'Connection refused. Is this the right IP address?';
						}
						else {
							errString = result.error.code.toString();
						}
						self.log('error', 'Error from Camera: ' + errString);	
					}
				}
				catch(error) {
					self.log('error', 'Camera gave an error: ' + error);
				}
			}
		)
	}
}

instance.prototype.actions = function (system) {
	this.setActions(actions.setActions(this));
}

instance_skel.extendedBy(instance);
exports = module.exports = instance;