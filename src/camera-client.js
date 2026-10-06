const http = require('http')

function delay(ms) {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms)
	})
}

function tagValue(xml, tag) {
	const expression = new RegExp(
		'<(?:[A-Za-z0-9_-]+:)?' + tag + '(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_-]+:)?' + tag + '>',
		'i',
	)
	const match = expression.exec(xml || '')
	return match ? match[1].trim() : ''
}

function cameraResult(xml) {
	return tagValue(xml, 'result')
}

function logHeaders(headers) {
	const safe = {}
	for (const [name, value] of Object.entries(headers || {})) {
		safe[name] = /session|authorization|cookie/i.test(name) ? '[redacted]' : value
	}
	return safe
}

function logBody(body, query, client) {
	let safe = body.replace(/(<(?:[\w-]+:)?(?:UDN|serialNumber|sessionId|session_id)\b[^>]*>)[\s\S]*?(<\/[^>]+>)/gi, '$1[redacted]$2')
	// Access confirmation is a comma-separated reply whose last field is the new session.
	if (query.get('type') === 'req_acc_e' && /^ok,/i.test(safe.trim())) {
		safe = safe.replace(/,[^,]*$/, ',[redacted]')
	}
	for (const secret of [client.sessionId, client.deviceInfo && client.deviceInfo.udn, client.deviceInfo && client.deviceInfo.serialNumber]) {
		if (secret) safe = safe.split(secret).join('[redacted]')
	}
	return safe
}

function parseRecordingState(xml) {
	const tags = ['rec', 'recording', 'recording_state', 'video_rec', 'video_recording', 'movie_rec']

	for (let index = 0; index < tags.length; index++) {
		const value = tagValue(xml, tags[index]).toLowerCase()
		if (!value) continue
		if (['on', 'start', 'started', 'recording', 'rec', '1', 'true'].indexOf(value) !== -1) return true
		if (['off', 'stop', 'stopped', 'standby', '0', 'false'].indexOf(value) !== -1) return false
	}

	return null
}

class LumixCameraClient {
	constructor(options) {
		options = options || {}
		this.host = options.host || ''
		this.controllerName = options.controllerName || 'Bitfocus Companion'
		this.timeout = options.timeout || 15000
		this.connectionTimeout = options.connectionTimeout || 30000
		this.stateTimeout = options.stateTimeout || 8500
		this.accessAttempts = options.accessAttempts || 20
		this.accessRetryDelay = options.accessRetryDelay || 500
		this.log = options.log || function () {}
		this.sessionId = ''
		this.deviceInfo = null
		this._connecting = null
		this._heartbeatControllers = new Set()
		this._requestNumber = 0
		this._closed = false
		this.safetyStopped = false
		this._busyHeartbeats = 0
		this._pendingRecordingCommands = new Set()
	}

	setHost(host) {
		if (this.host !== host) {
			this.host = host || ''
			this.sessionId = ''
			this.deviceInfo = null
		}
	}

	_request(port, path, headers, timeout, signal) {
		const self = this
		return new Promise(function (resolve, reject) {
			if (!self.host) {
				reject(new Error('Camera IP is not configured'))
				return
			}

			const requestHeaders = Object.assign({ Connection: 'close' }, headers || {})
			// Describe the operation without logging pairing values or session credentials.
			const query = new URLSearchParams(path.split('?')[1] || '')
			const operation = port === 60606 ? 'discovery' : [query.get('mode'), query.get('type'), query.get('mode') === 'camcmd' ? query.get('value') : null].filter(Boolean).join('/')
			const safeQuery = new URLSearchParams(query)
			if (query.get('mode') === 'accctrl') {
				for (const name of ['value', 'value2']) if (safeQuery.has(name)) safeQuery.set(name, '[redacted]')
			}
			const safePath = path.split('?')[0] + (safeQuery.size ? '?' + safeQuery.toString() : '')
			const requestId = ++self._requestNumber
			const prefix = 'HTTP #' + requestId + ' '
			self.log(prefix + 'REQUEST GET http://' + self.host + ':' + port + safePath + '; timeout=' + (timeout || self.timeout) + 'ms; headers=' + JSON.stringify(logHeaders(requestHeaders)))
			const started = Date.now()
			let phase = 'waiting for response headers'
			let receivedBytes = 0
			let body = ''
			let settled = false
			let deadline
			function finish(error, response) {
				if (settled) return
				settled = true
				clearTimeout(deadline)
				const timing = operation + ' after ' + (Date.now() - started) + 'ms; ' + phase + '; received ' + receivedBytes + ' bytes'
				if (error) {
					error.message += ' [' + timing + ']'
					self.log(prefix + (signal && signal.aborted ? 'CANCELLED ' : 'FAILED ') + error.message + '; partialBody=' + JSON.stringify(logBody(body, query, self)))
					reject(error)
				} else {
					self.log(prefix + 'RESPONSE HTTP ' + response.statusCode + ' ' + timing + '; result=' + (cameraResult(response.body) || 'non-XML') + '; body=' + JSON.stringify(logBody(response.body, query, self)))
					resolve(response)
				}
			}
			const request = http.get(
				{
					host: self.host,
					port: port,
					path: path,
					headers: requestHeaders,
					agent: false,
					signal: signal,
					timeout: timeout || self.timeout,
				},
				function (response) {
					phase = 'HTTP ' + response.statusCode + ', waiting for response end'
					self.log(prefix + 'HEADERS after ' + (Date.now() - started) + 'ms; status=' + response.statusCode + '; headers=' + JSON.stringify(logHeaders(response.headers)))
					response.setEncoding('utf8')
					response.on('data', function (chunk) {
						body += chunk
						receivedBytes += Buffer.byteLength(chunk)
					})
					response.on('end', function () {
						phase = 'response complete'
						finish(null, { statusCode: response.statusCode, body: body, headers: response.headers })
					})
					response.on('error', function (error) { finish(error) })
					response.on('aborted', function () { finish(new Error('Camera response aborted')) })
				},
			)

			request.on('timeout', function () {
				request.destroy(new Error('Camera request timed out'))
			})
			request.on('error', function (error) { finish(error) })
			// Socket inactivity timeouts do not bound DNS, connection setup, or a slow response.
			deadline = setTimeout(function () {
				request.destroy(new Error('Camera request deadline exceeded'))
			}, timeout || self.timeout)
		})
	}

	_assertHttpOk(response, description) {
		if (!response || response.statusCode < 200 || response.statusCode >= 300) {
			throw new Error(description + ' failed with HTTP ' + (response ? response.statusCode : 'unknown'))
		}
	}

	async _camRequest(query, includeSession, timeout, signal) {
		if (this._closed) throw new Error('Camera client has been disconnected')
		const headers = {}
		if (includeSession && this.sessionId) headers['X-SESSION_ID'] = this.sessionId
		const response = await this._request(80, '/cam.cgi?' + query, headers, timeout, signal)
		if (cameraResult(response.body) === 'err_busy' || this.safetyStopped) {
			const error = new Error(this.safetyStopped
				? 'Camera traffic stopped after consecutive busy heartbeats. Recover the camera, then disable and enable the module to resume.'
				: 'Camera returned err_busy')
			error.cameraResult = 'err_busy'
			throw error
		}
		if (cameraResult(response.body) === 'err_critical') {
			this.sessionId = ''
			const error = new Error('Camera returned err_critical; session invalidated')
			error.cameraResult = 'err_critical'
			throw error
		}
		return response
	}

	async connect() {
		if (this._closed) throw new Error('Camera client has been disconnected')
		if (this._connecting) return this._connecting
		if (this.sessionId) return this.deviceInfo

		const self = this
		this._connecting = (async function () {
			self.sessionId = ''
			if (!self.deviceInfo || !self.deviceInfo.udn || self._discoveryHost !== self.host) {
				self.log('Handshake: discovering camera')
				const description = await self._request(60606, '/Lumix/Server0/ddd', undefined, self.connectionTimeout)
				self._assertHttpOk(description, 'Camera discovery')
				const rawUdn = tagValue(description.body, 'UDN')
				const udn = rawUdn && rawUdn.replace(/^uuid:/i, '')
				if (!udn) throw new Error('Camera discovery response did not contain a UDN')
				// Cache only a completed, validated discovery reply, scoped to this
				// client's host. No session/access tokens are reused after a failure.
				self.deviceInfo = {
					friendlyName: tagValue(description.body, 'friendlyName'),
					manufacturer: tagValue(description.body, 'manufacturer'),
					modelName: tagValue(description.body, 'modelName'),
					modelNumber: tagValue(description.body, 'modelNumber'),
					serialNumber: tagValue(description.body, 'serialNumber'),
					udn: udn,
					firmwareVersion: tagValue(description.body, 'X_FirmVersion'),
				}
				self._discoveryHost = self.host
			} else self.log('Handshake: reusing completed camera discovery for this host')
			const udn = self.deviceInfo.udn

			const accessStart = await self._camRequest('mode=accctrl&type=req_acc_g', false, self.connectionTimeout)
			self._assertHttpOk(accessStart, 'Camera access request')

			const encodedUdn = Buffer.from(udn, 'utf8').toString('hex')
			const encodedName = Buffer.from(self.controllerName, 'utf8').toString('hex')
			let lastResponse = ''

			for (let attempt = 0; attempt < self.accessAttempts; attempt++) {
				const access = await self._camRequest(
					'mode=accctrl&type=req_acc_e&value=' +
						encodeURIComponent(encodedUdn) +
						'&value2=' +
						encodeURIComponent(encodedName),
					false,
					self.connectionTimeout,
				)
				self._assertHttpOk(access, 'Camera access confirmation')
				lastResponse = access.body.trim()
				const values = lastResponse.split(',').map(function (value) {
					return value.trim()
				})
				if (values[0].toLowerCase() === 'ok') {
					self.sessionId = values[values.length - 1]
					self.log('Handshake: access granted; confirming controller name')
					break
				}
				await delay(self.accessRetryDelay)
			}

			if (!self.sessionId) {
				throw new Error('Camera did not grant access' + (lastResponse ? ': ' + lastResponse : ''))
			}

			const setName = await self._camRequest(
				'mode=setsetting&type=device_name&value=' + encodeURIComponent(self.controllerName),
				true,
				self.connectionTimeout,
			)
			self._assertHttpOk(setName, 'Controller name confirmation')
			if (cameraResult(setName.body) !== 'ok') {
				throw new Error('Camera rejected controller name: ' + (cameraResult(setName.body) || setName.body))
			}
			self.log('Handshake: establishing shooting mode')
			const recMode = await self._camRequest('mode=camcmd&value=recmode', true, self.timeout)
			self._assertHttpOk(recMode, 'Shooting mode setup')
			if (cameraResult(recMode.body) !== 'ok') throw new Error('Camera rejected shooting mode: ' + cameraResult(recMode.body))

			return self.deviceInfo
		})()

		try {
			return await this._connecting
		} catch (error) {
			// A provisional access token is not a usable connection until confirmation succeeds.
			this.sessionId = ''
			throw error
		} finally {
			this._connecting = null
		}
	}

	command(query, retryAccess, timeout, acceptedResults) {
		const recording = query === 'mode=camcmd&value=video_recstart' || query === 'mode=camcmd&value=video_recstop'
		if (recording && this._pendingRecordingCommands.has(query)) {
			return Promise.reject(new Error('Duplicate recording request ignored: the same command is still awaiting a reply'))
		}
		if (recording) this._pendingRecordingCommands.add(query)
		return this._command(query, retryAccess, timeout, acceptedResults).finally(() => {
			if (recording) this._pendingRecordingCommands.delete(query)
		})
	}

	async _command(query, retryAccess, timeout, acceptedResults) {
		if (this._closed) throw new Error('Camera client has been disconnected')
		if (retryAccess === undefined) retryAccess = true
		if (this._connecting || !this.sessionId) await this.connect()

		const response = await this._camRequest(query, true, timeout)
		this._assertHttpOk(response, 'Camera command')
		const result = cameraResult(response.body)

		if (retryAccess && (result === 'err_reject' || result === 'err_session')) {
			this.sessionId = ''
			await this.connect()
			return this._command(query, false, timeout, acceptedResults)
		}

		if (result && result !== 'ok' && (!acceptedResults || acceptedResults.indexOf(result) === -1)) {
			throw new Error('Camera returned ' + result)
		}
		if (!result) throw new Error('Camera returned an invalid response')
		return response.body
	}

	getState() {
		return this.command('mode=getstate', true, this.stateTimeout)
	}

	async heartbeat() {
		if (this._closed || this._connecting || this._heartbeatControllers.size > 0 || !this.sessionId) return null
		const controller = new AbortController()
		this._heartbeatControllers.add(controller)
		// Only one heartbeat at a time; control requests remain independent.
		try {
			const response = await this._camRequest('mode=getsetting&type=iso', true, this.stateTimeout, controller.signal)
			this._assertHttpOk(response, 'Camera heartbeat')
			const result = cameraResult(response.body)
			// ISO-only keepalive experiment: no getstate or extra settings requests.
			if (result !== 'ok') {
				throw new Error('Camera heartbeat returned ' + (result || 'an invalid response'))
			}
			this._busyHeartbeats = 0
			return response.body
		} catch (error) {
			if (error.cameraResult === 'err_busy') {
				this._busyHeartbeats++
				if (this._busyHeartbeats >= 3) {
					this.safetyStopped = true
					this.disconnect()
					error.message = 'Camera returned err_busy on 3 consecutive heartbeats; traffic stopped. Recover the camera, then disable and enable the module to resume.'
				}
				throw error
			}
			this._busyHeartbeats = 0
			if (controller.signal.aborted) return null
			throw error
		} finally {
			this._heartbeatControllers.delete(controller)
		}
	}

	disconnect() {
		this._closed = true
		for (const controller of this._heartbeatControllers) controller.abort()
		this.sessionId = ''
		this.deviceInfo = null
	}
}

module.exports = {
	LumixCameraClient: LumixCameraClient,
	cameraResult: cameraResult,
	parseRecordingState: parseRecordingState,
	tagValue: tagValue,
}
