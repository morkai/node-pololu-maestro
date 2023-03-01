// Part of <https://github.com/morkai/node-pololu-maestro> licensed under <MIT>

const {EventEmitter} = require('events');
const {BufferQueueReader} = require('h5.buffers');

module.exports = class Master extends EventEmitter
{
  constructor(options)
  {
    super();

    this.responseTimeout = options.responseTimeout || 100;
    this.serialPort = options.serialPort;

    this.requestQueue = [];
    this.responseHandlers = [];
    this.responseBuffer = new BufferQueueReader();

    this.serialPort.on('error', this.onSerialPortError.bind(this));
    this.serialPort.on('open', this.onSerialPortOpen.bind(this));
    this.serialPort.on('close', this.onSerialPortClose.bind(this));
    this.serialPort.on('data', this.onSerialPortData.bind(this));
  }

  ready(done)
  {
    if (this.isOpen())
    {
      setImmediate(done);
    }
    else
    {
      this.serialPort.once('open', done);
    }
  }

  isOpen()
  {
    return this.serialPort.isOpen;
  }

  setTarget({device, channel, target})
  {
    return new Promise((resolve, reject) =>
    {
      const targetLow = target & 0x7F;
      const targetHigh = (target >> 7) & 0x7F;
      const requestFrame = Buffer.from([0xAA, device, 0x04, channel, targetLow, targetHigh]);

      this.requestAndForget(requestFrame, resolve, reject);
    });
  }

  trySetTarget(options)
  {
    return this.setTarget(options)
      .then(() => this.getPosition(options))
      .then((actualTarget) =>
      {
        if (actualTarget !== options.target)
        {
          throw new Error(
            `Expected the target of ${options.device}:${options.channel} to be ${options.target}, got: ${actualTarget}.`
          );
        }
      });
  }

  setMultipleTargets({device, channel, targets})
  {
    return new Promise((resolve, reject) =>
    {
      const requestFrame = Buffer.allocUnsafe(5 + targets.length * 2);

      requestFrame[0] = 0xAA;
      requestFrame[1] = device;
      requestFrame[2] = 0x1F;
      requestFrame[3] = targets.length;
      requestFrame[4] = channel;

      targets.forEach((target, i) =>
      {
        const frameI = 5 + i * 2;

        requestFrame[frameI] = target & 0x7F;
        requestFrame[frameI + 1] = (target >> 7) & 0x7F;
      });

      this.requestAndForget(requestFrame, resolve, reject);
    });
  }

  trySetMultipleTargets(options)
  {
    const channels = options.targets.map((v, i) => options.channel + i);

    return this.setMultipleTargets(options)
      .then(() => this.getMultiplePositions({device: options.device, channels}))
      .then((actualTargets) =>
      {
        options.targets.forEach(({channel, target}) =>
        {
          const actualTarget = actualTargets[channel];

          if (actualTarget !== target)
          {
            throw new Error(
              `Expected the target of ${options.device}:${channel} to be ${target}, got: ${actualTarget}.`
            )
          }
        });
      });
  }

  getPosition({device, channel})
  {
    return new Promise((resolve, reject) =>
    {
      const requestFrame = Buffer.from([0xAA, device, 0x10, channel]);

      this.requestAndResponse(requestFrame, 2, (err, responseFrame) =>
      {
        if (err)
        {
          return reject(err);
        }

        const position = ((responseFrame[1] << 8) + responseFrame[0]) & 0xFFFF;

        resolve(position);
      });
    });
  }

  getMultiplePositions({device, channels})
  {
    return new Promise(async (resolve, reject) =>
    {
      const result = {};

      for (let channel of channels)
      {
        try
        {
          result[channel] = await this.getPosition({device, channel});
        }
        catch (err)
        {
          return reject(new Error(`Failed to get position for channel ${device}:${channel}: ${err.message}`));
        }
      }

      resolve(result);
    });
  }

  requestAndForget(requestFrame, resolve, reject)
  {
    this.request(requestFrame, (err, complete) =>
    {
      if (err)
      {
        return reject(err);
      }

      complete();
      resolve();
    });
  }

  requestAndResponse(requestFrame, responseLength, done)
  {
    this.request(requestFrame, (err, complete) =>
    {
      if (err)
      {
        return done(err);
      }

      const responseHandler = {
        responseLength,
        callback: (err, responseFrame) =>
        {
          complete();
          done(err, responseFrame);
        },
        timeout: null
      };

      responseHandler.timeout = setTimeout(() =>
      {
        const i = this.responseHandlers.indexOf(responseHandler);

        this.responseHandlers.splice(i, 1);

        responseHandler.callback(new Error('Response timeout.'));
      }, this.responseTimeout);

      this.responseHandlers.push(responseHandler);
    });
  }

  request(requestFrame, done)
  {
    if (!this.serialPort.isOpen)
    {
      return done(new Error('Serial port closed.'));
    }

    const request = {
      frame: requestFrame,
      callback: done
    };

    this.requestQueue.push(request);

    if (this.requestQueue.length === 1)
    {
      this.writeNextRequest();
    }
  }

  writeNextRequest()
  {
    if (!this.requestQueue.length)
    {
      return;
    }

    const request = this.requestQueue[0];

    this.serialPort.write(request.frame, null, (err) =>
    {
      if (err)
      {
        this.requestQueue.shift();

        return request.callback(err);
      }

      request.callback(null, () =>
      {
        this.requestQueue.shift();

        if (this.requestQueue.length)
        {
          this.writeNextRequest();
        }
      });
    });
  }

  onSerialPortError(err)
  {
    this.emit('error', err);
  }

  onSerialPortOpen()
  {
    this.emit('open');
  }

  onSerialPortClose()
  {
    this.emit('close');
  }

  onSerialPortData(data)
  {
    if (!this.responseHandlers.length)
    {
      return;
    }

    this.responseBuffer.push(data);

    if (this.responseBuffer.length < this.responseHandlers[0].responseLength)
    {
      return;
    }

    const responseHandler = this.responseHandlers.shift();

    clearTimeout(responseHandler.timeout);

    const responseFrame = this.responseBuffer.shiftBuffer(responseHandler.responseLength);

    responseHandler.callback(null, responseFrame);

    if (this.responseBuffer.length && !this.responseHandlers.length)
    {
      this.responseBuffer.skip();
    }
  }
};
