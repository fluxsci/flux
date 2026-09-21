# A real private D-Bus service, exercising the SHIPPED portal helper end to end.
import json
import os
import subprocess
import sys
from gi.repository import Gio, GLib

mode, helper = sys.argv[1:]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
closed = False
xml = '''<node><interface name="org.freedesktop.portal.Screenshot"><method name="PickColor"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method></interface><interface name="org.freedesktop.portal.Request"><method name="Close"/></interface></node>'''
info = Gio.DBusNodeInfo.new_for_xml(xml)


def method(connection, sender, object_path, interface, name, params, invocation):
    global closed
    if name == 'Close':
        closed = True
        invocation.return_value(None)
        return
    direct_errors = {
        'unavailable': 'org.freedesktop.DBus.Error.UnknownMethod',
        'notallowed': 'org.freedesktop.portal.Error.NotAllowed',
        'accessdenied': 'org.freedesktop.DBus.Error.AccessDenied',
        'failed': 'org.freedesktop.DBus.Error.Failed',
    }
    if mode in direct_errors:
        invocation.return_dbus_error(direct_errors[mode], 'Fixture direct method error')
        return
    parent, options = params.unpack()
    assert parent == ''
    token = options['handle_token']
    request = '/org/freedesktop/portal/desktop/request/' + sender[1:].replace('.', '_') + '/' + token
    connection.register_object(request, info.interfaces[1], method, None, None)
    invocation.return_value(GLib.Variant('(o)', (request,)))
    if mode == 'cancel':
        child.stdin.write(b'cancel\n')
        child.stdin.flush()
        return

    def reply():
        status = 1 if mode == 'refuse' else 0
        color = (float('nan'), .5, 1.) if mode == 'invalid' else (.25, .5, 1.)
        connection.emit_signal(sender, request, 'org.freedesktop.portal.Request', 'Response', GLib.Variant('(ua{sv})', (status, {'color': GLib.Variant('(ddd)', color)})))
        return False
    GLib.idle_add(reply)


bus.register_object('/org/freedesktop/portal/desktop', info.interfaces[0], method, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.freedesktop.portal.Desktop', 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
child = subprocess.Popen(['/usr/bin/python3', '-I', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def done():
    if child.poll() is None:
        return True
    result = json.loads(child.stdout.read())
    expected = {'picked': {'status': 'picked', 'hex': '#4080ff'}, 'refuse': {'status': 'cancelled'}, 'cancel': {'status': 'cancelled'}, 'unavailable': {'status': 'unavailable'}, 'invalid': {'status': 'error'}, 'notallowed': {'status': 'cancelled'}, 'accessdenied': {'status': 'cancelled'}, 'failed': {'status': 'error'}}[mode]
    assert result == expected, (mode, result)
    assert child.returncode == 0, child.stderr.read()
    assert closed == (mode == 'cancel'), (mode, closed)
    print('PASS', mode, json.dumps(result), 'requestClosed=' + str(closed), flush=True)
    loop.quit()
    return False


def timeout():
    child.kill()
    os._exit(2)


GLib.timeout_add(20, done)
GLib.timeout_add_seconds(5, timeout)
loop.run()
