# Optional Linux system helper; invoked only for an explicit eyedropper action.
# Portal owns permission, the visible crosshair, and the user's cancellation.
import json
import math
import os
import sys
import uuid

try:
    from gi.repository import Gio, GLib
except ImportError:
    print(json.dumps({'status': 'unavailable'}), flush=True)
    raise SystemExit(0)

BUS = 'org.freedesktop.portal.Desktop'
OBJECT = '/org/freedesktop/portal/desktop'
REQUEST = 'org.freedesktop.portal.Request'
loop = GLib.MainLoop()
finished = False
request_path = None
bus = None


def finish(result):
    global finished
    if finished:
        return
    finished = True
    print(json.dumps(result), flush=True)
    loop.quit()


def cancel(*_args):
    if request_path and bus:
        try:
            bus.call_sync(BUS, request_path, REQUEST, 'Close', None, None,
                          Gio.DBusCallFlags.NONE, 1000, None)
        except GLib.Error:
            pass
    finish({'status': 'cancelled'})
    return False


def response(_bus, _sender, _path, _interface, _signal, params):
    status, values = params.unpack()
    if status != 0:
        # Refusal is cancellation, never a reason to capture behind a permission UI.
        finish({'status': 'cancelled'})
        return
    rgb = values.get('color')
    if not isinstance(rgb, tuple) or len(rgb) != 3 or not all(
            isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in rgb):
        finish({'status': 'error'})
        return
    finish({'status': 'picked', 'hex': '#' + ''.join(f'{math.floor(v * 255 + .5):02x}' for v in rgb)})


def requested(connection, result):
    global request_path
    try:
        actual, = connection.call_finish(result).unpack()
        if actual != request_path:
            # Older portals can choose a different handle. Subscribe to that path
            # before returning to the main loop so queued responses cannot be lost.
            request_path = actual
            connection.signal_subscribe(BUS, REQUEST, 'Response', actual, None,
                                        Gio.DBusSignalFlags.NONE, response)
    except GLib.Error as error:
        # A direct method error can be a permission refusal, not merely a
        # missing portal. Only a positively absent capability permits fallback.
        remote = Gio.DBusError.get_remote_error(error)
        if remote in {
            'org.freedesktop.DBus.Error.ServiceUnknown',
            'org.freedesktop.DBus.Error.NameHasNoOwner',
            'org.freedesktop.DBus.Error.UnknownMethod',
            'org.freedesktop.DBus.Error.UnknownInterface',
        }:
            finish({'status': 'unavailable'})
        elif remote in {
            'org.freedesktop.portal.Error.NotAllowed',
            'org.freedesktop.DBus.Error.AccessDenied',
            'org.freedesktop.DBus.Error.AuthFailed',
        }:
            finish({'status': 'cancelled'})
        else:
            finish({'status': 'error'})


try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = 'flux_color_' + uuid.uuid4().hex
    owner = bus.get_unique_name()[1:].replace('.', '_')
    request_path = f'/org/freedesktop/portal/desktop/request/{owner}/{token}'
    bus.signal_subscribe(BUS, REQUEST, 'Response', request_path, None,
                         Gio.DBusSignalFlags.NONE, response)
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, cancel)
    # Empty parent is explicitly supported by the portal; Chromium's Wayland
    # native window handle is not a portal-exported window identifier.
    bus.call(BUS, OBJECT, 'org.freedesktop.portal.Screenshot', 'PickColor',
             GLib.Variant('(sa{sv})', ('', {'handle_token': GLib.Variant('s', token)})),
             GLib.VariantType.new('(o)'), Gio.DBusCallFlags.NONE, 5000, None, requested)
    GLib.timeout_add_seconds(120, cancel)
    loop.run()
except GLib.Error:
    finish({'status': 'unavailable'})
finally:
    if bus:
        bus.close_sync(None)
