// Part of <https://github.com/morkai/node-pololu-maestro> licensed under <MIT>

const {exec} = require('child_process');
const {readdir, realpath} = require('fs');

module.exports = function list(done)
{
  if (process.platform === 'win32')
  {
    listWin32(done);
  }
  else
  {
    listLinux(done);
  }
};

function listWin32(done)
{
  const cmd = `wmic PATH CIM_LogicalDevice`
    + ` WHERE "DeviceID LIKE 'COM%' AND Name LIKE '%Pololu Mini Maestro%'"`
    + ` GET DeviceID, Name /VALUE`;

  exec(cmd, (err, stdout) =>
  {
    if (err)
    {
      return done(err);
    }

    const devices = [];

    stdout.split('\r\n').forEach(line =>
    {
      const matches = line.trim().match(/^([A-Za-z]+)=(.*?)$/);

      if (!matches)
      {
        return;
      }

      const [_, key, value] = matches;

      if (key === 'DeviceID')
      {
        devices.push({
          path: value,
          channels: null,
          port: null,
          serial: null
        });

        return;
      }

      if (devices.length && key === 'Name')
      {
        const matches = value.match(/([0-9]+)-Channel.*?(Command|TTL) Port/);

        if (matches)
        {
          const device = devices[devices.length - 1];

          device.channels = parseInt(matches[1], 10);
          device.port = matches[2] === 'Command' ? 'cmd' : 'ttl';
        }
      }
    });

    done(null, groupDevices(devices));
  });
}

function listLinux(done)
{
  const devices = [];
  let completed = false;

  function complete(err)
  {
    if (completed)
    {
      return;
    }

    completed = true;

    done(err, groupDevices(devices));
  }

  exec('lsusb -v -d 1ffb:', (err, stdout) =>
  {
    if (err)
    {
      return done(err);
    }

    const interfaces = [];
    let bus = null;
    let device = null;
    let serial = null;
    let channels = null;
    let port = null;

    stdout.split('\n').forEach(line =>
    {
      let matches = line.match(/Bus ([0-9]+) Device ([0-9]+): ID 1ffb/);

      if (matches)
      {
        bus = matches[1];
        device = matches[2];
        serial = null;
        channels = null;
        port = null;

        return;
      }

      if (!bus)
      {
        return;
      }

      matches = line.match(/iSerial\s+[0-9]+\s+([0-9]+)/);

      if (matches)
      {
        serial = matches[1];

        return;
      }

      if (!serial)
      {
        return;
      }

      matches = line.match(/iFunction\s+[0-9]+\s+Pololu Mini Maestro ([0-9]+).*?(Command|TTL)/);

      if (matches)
      {
        channels = parseInt(matches[1], 10);
        port = matches[2] === 'Command' ? 'cmd' : 'ttl';

        return;
      }

      if (!channels)
      {
        return;
      }

      matches = line.match(/bInterfaceNumber\s+([0-9]+)/);

      if (matches)
      {
        interfaces.push({
          serial,
          channels,
          port,
          no: parseInt(matches[1], 10),
          id: null
        });

        channels = null;
        port = null;
      }
    });

    if (!interfaces.length)
    {
      return done(null, devices);
    }

    readdir('/dev/serial/by-id', (err, ids) =>
    {
      if (err)
      {
        return done(err);
      }

      let processed = 0;

      interfaces.forEach(iface =>
      {
        iface.id = ids.find(id => id.includes(`${iface.serial}-if${iface.no.toString().padStart(2, '0')}`));

        if (!iface)
        {
          ++processed;

          if (processed === interfaces.length)
          {
            complete();
          }

          return;
        }

        realpath(`/dev/serial/by-id/${iface.id}`, (err, path) =>
        {
          if (err)
          {
            return complete(err);
          }

          ++processed;

          devices.push({
            path,
            channels: iface.channels,
            port: iface.port,
            serial: iface.serial
          });

          if (processed === interfaces.length)
          {
            complete();
          }
        });
      });
    });
  });
}

function groupDevices(devices)
{
  const grouped = {};

  devices.forEach(device =>
  {
    if (!grouped[device.serial])
    {
      grouped[device.serial] = {
        serialNumber: device.serial,
        channelCount: device.channels,
        cmd: null,
        ttl: null
      };
    }

    grouped[device.serial][device.port] = device.path;
  });

  return grouped;
}
