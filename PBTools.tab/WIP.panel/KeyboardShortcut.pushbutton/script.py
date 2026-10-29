# -*- coding: utf-8 -*-
__title__ = "Keyboard\nShortcut"
__doc__ = """Click this button, then click any command on the ribbon (also inside drop-downs or the Quick Access
Toolbar): a window opens where you type the new keyboard shortcut for that command. The shortcut works right
away, no restart, and is saved in Revit's normal KeyboardShortcuts.xml. The clicked command starts as usual -
press Esc to cancel it. 'Search instead' finds commands by name. Works in Revit 2023 and 2025."""
__persistentengine__ = True   # keeps listening for the ribbon click after the script ends

import clr
clr.AddReference("AdWindows")
clr.AddReference("UIFramework")
clr.AddReference("UIFrameworkServices")
clr.AddReference("PresentationCore")
clr.AddReference("PresentationFramework")
clr.AddReference("WindowsBase")
from System import Action, AppDomain, DateTime
from System.Collections.Generic import Dictionary
from System.Windows import Visibility
from System.Windows.Input import Key, Keyboard
from System.Windows.Threading import Dispatcher, DispatcherPriority
from Autodesk.Windows import ComponentManager
import UIFramework
import UIFrameworkServices

from pyrevit import forms, script

logger = script.get_logger()

SESSION_KEY = "PomadaTools.KeyboardShortcut.Pick"   # running ribbon pick, so a second click can stop it
MAX_KEYS = 5                                         # Revit allows up to 5 typed characters
IGNORE_SECONDS = 0.3                                 # the click on this button itself is not the command
RESERVED = set("Ctrl+" + k for k in "CVXZYSONP")     # copy, paste, cut, undo, redo, save, open, new, print
TITLE = "Keyboard Shortcut"

HINT_XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Keyboard Shortcut" SizeToContent="WidthAndHeight" ResizeMode="NoResize" Topmost="True"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="False" Closed="hint_closed">
  <StackPanel Margin="14" Width="370">
    <TextBlock FontWeight="Bold" FontSize="14" Text="Click the command on the ribbon"/>
    <TextBlock TextWrapping="Wrap" Margin="0,6,0,0" Foreground="#555555"
               Text="Also inside drop-downs and the Quick Access Toolbar. The command starts as usual - press Esc in Revit to cancel it."/>
    <TextBlock x:Name="status_tb" TextWrapping="Wrap" Margin="0,6,0,0" Foreground="#E87830"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,12,0,0">
      <Button Content="Search instead..." Width="115" Click="search_click"/>
      <Button Content="Cancel" Width="80" Margin="8,0,0,0" Click="cancel_click"/>
    </StackPanel>
  </StackPanel>
</Window>
"""

EDITOR_XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Keyboard Shortcut" Width="580" Height="560" MinWidth="460" MinHeight="400"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="False">
  <DockPanel Margin="12">
    <StackPanel DockPanel.Dock="Top">
      <TextBlock x:Name="name_tb" FontSize="15" FontWeight="Bold" TextWrapping="Wrap"/>
      <TextBlock x:Name="path_tb" Foreground="#777777" TextWrapping="Wrap"/>
      <TextBlock x:Name="current_tb" Margin="0,8,0,0" TextWrapping="Wrap"/>
      <DockPanel Margin="0,10,0,0">
        <TextBlock Text="New shortcut:" VerticalAlignment="Center" Margin="0,0,8,0"/>
        <Button x:Name="clear_btn" Content="Remove all" Width="85" DockPanel.Dock="Right" Margin="6,0,0,0"
                Click="clear_click"/>
        <Button x:Name="replace_btn" Content="Replace" Width="75" DockPanel.Dock="Right" Margin="6,0,0,0"
                Click="replace_click" ToolTip="Use only the new shortcut for this command"/>
        <Button x:Name="add_btn" Content="Add" Width="65" DockPanel.Dock="Right" Margin="6,0,0,0"
                Click="add_click" ToolTip="Keep the current shortcuts and add the new one (Enter)"/>
        <TextBox x:Name="keys_tb" FontSize="14" FontWeight="Bold" Padding="4,2" PreviewKeyDown="keys_down"/>
      </DockPanel>
      <TextBlock Margin="0,4,0,0" Foreground="#555555" FontSize="11" TextWrapping="Wrap"
                 Text="Type up to 5 letters / digits (e.g. AP), or hold Ctrl, Shift or Ctrl+Alt and press a key. Backspace deletes, Enter adds."/>
      <TextBlock x:Name="conflict_tb" Margin="0,6,0,0" Foreground="#E87830" TextWrapping="Wrap"/>
      <CheckBox x:Name="steal_cb" Content="Remove it from the other command(s)" IsChecked="True"
                Visibility="Collapsed" Margin="0,4,0,0"/>
      <TextBlock x:Name="status_tb" Margin="0,6,0,0" Foreground="#3AA655" FontWeight="Bold" TextWrapping="Wrap"/>
      <DockPanel Margin="0,14,0,6">
        <TextBlock Text="Other command:" VerticalAlignment="Center" Margin="0,0,8,0"/>
        <Button Content="Pick on ribbon" Width="105" DockPanel.Dock="Right" Margin="6,0,0,0" Click="pick_click"/>
        <TextBox x:Name="search_tb" Padding="3" TextChanged="search_changed" ToolTip="Search by name or shortcut"/>
      </DockPanel>
    </StackPanel>
    <DockPanel DockPanel.Dock="Bottom" LastChildFill="False" Margin="0,8,0,0">
      <Button Content="Close" Width="80" DockPanel.Dock="Right" Click="close_click"/>
    </DockPanel>
    <ListBox x:Name="list_lb" SelectionChanged="list_changed"/>
  </DockPanel>
</Window>
"""


# ---------------- Revit's shortcut service (UIFramework, the same one the Keyboard Shortcuts dialog uses) -------

def framework_type(name):
    for namespace in (UIFramework, UIFrameworkServices):
        t = getattr(namespace, name, None)
        if t is not None:
            return t
    return None


ShortcutsHelper = framework_type("ShortcutsHelper")
KeyboardShortcutService = framework_type("KeyboardShortcutService")
ControlHelper = framework_type("ControlHelper")
ShortcutItem = framework_type("ShortcutItem")


def load_commands():
    """All commands that can have a shortcut: {command id: ShortcutItem}."""
    ShortcutsHelper.LoadCommands()
    return ShortcutsHelper.Commands


def keys_of(item):
    return [k for k in (item.ShortcutsRep or "").split("#") if k]


def clean(text):
    return u" ".join((text or u"").split())


def first_path(item):
    paths = getattr(item, "Paths", None)
    if not paths:
        return u""
    try:
        first = paths.split(";")[0]
    except AttributeError:
        first = list(paths)[0] if list(paths) else u""
    return clean(first).replace(u">", u" > ")


def label(item):
    keys = keys_of(item)
    text = clean(item.CommandName)
    if keys:
        text += u"   [{}]".format(u", ".join(keys))
    path = first_path(item)
    return text + (u"   -   " + path if path else u"")


def ribbon_command_id(item, commands):
    """Command id of a clicked ribbon item (split buttons run their current item)."""
    candidates = []
    for it in (getattr(item, "Current", None), item):
        if it is None:
            continue
        if ControlHelper is not None:
            try:
                candidates.append(ControlHelper.GetCommandId(it))
            except Exception:
                pass
        candidates.append(getattr(it, "Id", None))
    for cid in candidates:
        if cid and commands.ContainsKey(cid):
            return cid
    return None


def save_shortcuts(commands, changes):
    """changes: {command id: [shortcuts]} -> applied in Revit right away and saved to KeyboardShortcuts.xml."""
    items = dict((cid, commands[cid]) for cid in changes)
    old = dict((cid, item.ShortcutsRep) for cid, item in items.items())
    item_type = ShortcutItem or clr.GetPythonType(list(items.values())[0].GetType())
    changed = Dictionary[str, item_type]()
    try:
        for cid, keys in changes.items():
            items[cid].ShortcutsRep = u"#".join(keys) if keys else None
            changed[cid] = items[cid]
        KeyboardShortcutService.applyShortcutChanges(changed)
    except Exception:
        for cid, rep in old.items():
            items[cid].ShortcutsRep = rep
        raise


# ---------------- waiting for the ribbon click ----------------

def stop_running_pick():
    old = AppDomain.CurrentDomain.GetData(SESSION_KEY)
    if old is not None:
        try:
            old.stop()
        except Exception:
            pass


class HintWindow(forms.WPFWindow):
    def __init__(self, session):
        forms.WPFWindow.__init__(self, HINT_XAML, literal_string=True)
        self.session = session

    def search_click(self, sender, args):
        self.session.stop()
        open_editor(self.session.commands, None)

    def cancel_click(self, sender, args):
        self.session.stop()

    def hint_closed(self, sender, args):
        self.session.stop()


class PickSession(object):
    """Listens to ribbon clicks until one of them is a command that can have a shortcut."""

    def __init__(self, commands):
        self.commands = commands
        self.reloaded = False
        self.done = False
        self.started = DateTime.Now
        self.handler = self.on_ribbon            # same object for += and -=
        self.events = []
        for name in ("UIElementActivated", "ItemExecuted"):
            try:
                event = getattr(ComponentManager, name)
                event += self.handler
                self.events.append(name)
            except Exception:
                pass
        AppDomain.CurrentDomain.SetData(SESSION_KEY, self)
        self.hint = HintWindow(self)
        self.hint.show()

    def stop(self):
        if self.done:
            return
        self.done = True
        for name in self.events:
            try:
                event = getattr(ComponentManager, name)
                event -= self.handler
            except Exception:
                pass
        if AppDomain.CurrentDomain.GetData(SESSION_KEY) is self:
            AppDomain.CurrentDomain.SetData(SESSION_KEY, None)
        try:
            self.hint.Close()
        except Exception:
            pass

    def on_ribbon(self, sender, args):
        try:
            if self.done or (DateTime.Now - self.started).TotalSeconds < IGNORE_SECONDS:
                return
            item = getattr(args, "Item", None)
            if item is None:
                return
            cid = ribbon_command_id(item, self.commands)
            if cid is None and not self.reloaded:       # e.g. buttons added after the list was read
                self.reloaded = True
                self.commands = load_commands()
                cid = ribbon_command_id(item, self.commands)
            if cid is None:
                self.hint.status_tb.Text = (u"'{}' has no keyboard shortcut entry - click another command or "
                                            u"use Search.".format(clean(getattr(item, "Text", u"")) or u"This"))
                return
            self.stop()
            commands = self.commands
            # after Revit has handled the click, so the window gets the focus
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                                                     Action(lambda: open_editor(commands, cid)))
        except Exception as ex:
            logger.error("Keyboard Shortcut: {}".format(ex))


# ---------------- shortcut window ----------------

def key_name(key):
    name = str(key)
    if len(name) == 1 and name.isalpha():
        return name.upper()
    if len(name) == 2 and name[0] == "D" and name[1].isdigit():
        return name[1]
    if name.startswith("NumPad") and name[-1].isdigit():
        return name[-1]
    return None


def modifiers():
    mods = []
    if Keyboard.IsKeyDown(Key.LeftCtrl) or Keyboard.IsKeyDown(Key.RightCtrl):
        mods.append("Ctrl")
    if Keyboard.IsKeyDown(Key.LeftAlt) or Keyboard.IsKeyDown(Key.RightAlt):
        mods.append("Alt")
    if Keyboard.IsKeyDown(Key.LeftShift) or Keyboard.IsKeyDown(Key.RightShift):
        mods.append("Shift")
    return mods


def problem(keys):
    mods = keys.split("+")[:-1]
    if "Alt" in mods and "Ctrl" not in mods:
        return u"Alt + key opens the ribbon key tips (like Alt, B for PBTools). Use letters, Ctrl+... or Ctrl+Alt+..."
    if keys in RESERVED:
        return u"{} is reserved (copy, paste, undo, save ...). Choose another one.".format(keys)
    return None


class ShortcutWindow(forms.WPFWindow):
    def __init__(self, commands, command_id):
        forms.WPFWindow.__init__(self, EDITOR_XAML, literal_string=True)
        self.commands = commands
        self.cid = None
        self.new_keys = u""
        self.others = []
        self.shown = []
        self.rebuild_rows()
        self.set_command(command_id)
        self.apply_filter()

    # --- command list ---
    def rebuild_rows(self):
        rows = [(label(self.commands[c]), c) for c in self.commands.Keys]
        rows.sort(key=lambda r: r[0].lower())
        self.rows = rows

    def apply_filter(self):
        words = self.search_tb.Text.lower().split()
        self.shown = [r for r in self.rows if all(w in r[0].lower() for w in words)]
        self.list_lb.ItemsSource = [r[0] for r in self.shown]

    def search_changed(self, sender, args):
        self.apply_filter()

    def list_changed(self, sender, args):
        i = self.list_lb.SelectedIndex
        if 0 <= i < len(self.shown):
            self.set_command(self.shown[i][1], focus=False)

    # --- selected command ---
    def set_command(self, cid, focus=True):
        self.cid = cid
        item = self.commands[cid] if cid else None
        self.name_tb.Text = clean(item.CommandName) if item else u"Choose a command in the list below"
        self.path_tb.Text = first_path(item) if item else u""
        self.status_tb.Text = u""
        self.refresh_current()
        self.set_new(u"")
        if focus:
            self.Activate()
            self.keys_tb.Focus()

    def refresh_current(self):
        item = self.commands[self.cid] if self.cid else None
        keys = keys_of(item) if item else []
        self.current_tb.Text = (u"Current shortcuts:  " + u",  ".join(keys)) if keys else (
            u"No shortcut yet." if item else u"")
        self.clear_btn.IsEnabled = bool(keys)

    def keys_down(self, sender, e):
        e.Handled = True
        key = e.SystemKey if e.Key == Key.System else e.Key
        if key == Key.Enter:
            self.add_click(None, None)
            return
        if key in (Key.Back, Key.Delete):
            self.set_new(u"" if u"+" in self.new_keys else self.new_keys[:-1])
            return
        if key == Key.Tab:
            e.Handled = False
            return
        name = key_name(key)
        if name is None:
            return
        mods = modifiers()
        if mods:
            self.set_new(u"+".join(mods + [name]))
        else:
            typed = u"" if u"+" in self.new_keys else self.new_keys
            self.set_new((typed + name)[:MAX_KEYS])

    def set_new(self, keys):
        self.new_keys = keys
        self.keys_tb.Text = keys
        self.keys_tb.CaretIndex = len(keys)
        self.others = []
        message = u""
        ok = bool(keys) and self.cid is not None
        if ok:
            message = problem(keys) or u""
            ok = not message
        if ok:
            if keys.upper() in [k.upper() for k in keys_of(self.commands[self.cid])]:
                message = u"This command already has {}.".format(keys)
            self.others = [c for c in self.commands.Keys if c != self.cid and
                           keys.upper() in [k.upper() for k in keys_of(self.commands[c])]]
            if self.others:
                names = [clean(self.commands[c].CommandName) for c in self.others]
                message = u"{} is already used by: {}".format(keys, u";  ".join(names[:3]))
                if len(names) > 3:
                    message += u"  (+{} more)".format(len(names) - 3)
        self.conflict_tb.Text = message
        self.steal_cb.Visibility = Visibility.Visible if self.others else Visibility.Collapsed
        self.add_btn.IsEnabled = ok
        self.replace_btn.IsEnabled = ok

    # --- saving ---
    def save(self, keys, done_text):
        changes = {self.cid: keys}
        if self.new_keys and self.others and self.steal_cb.IsChecked:
            for c in self.others:
                changes[c] = [k for k in keys_of(self.commands[c]) if k.upper() != self.new_keys.upper()]
        try:
            save_shortcuts(self.commands, changes)
        except Exception as ex:
            forms.alert(u"Revit did not accept the shortcut:\n{}".format(ex), title=TITLE)
            return
        self.rebuild_rows()
        self.apply_filter()
        self.refresh_current()
        self.set_new(u"")
        self.status_tb.Text = done_text + u" Works right away."

    def add_click(self, sender, args):
        if not self.add_btn.IsEnabled:
            return
        keys = keys_of(self.commands[self.cid])
        if self.new_keys.upper() not in [k.upper() for k in keys]:
            keys.append(self.new_keys)
        self.save(keys, u"Added {}.".format(self.new_keys))

    def replace_click(self, sender, args):
        self.save([self.new_keys], u"Shortcut is now {}.".format(self.new_keys))

    def clear_click(self, sender, args):
        name = clean(self.commands[self.cid].CommandName)
        if forms.alert(u"Remove all shortcuts of '{}'?".format(name), title=TITLE, yes=True, no=True):
            self.new_keys = u""
            self.save([], u"All shortcuts removed.")

    def pick_click(self, sender, args):
        self.Close()
        PickSession(self.commands)

    def close_click(self, sender, args):
        self.Close()


def open_editor(commands, command_id):
    try:
        ShortcutWindow(commands, command_id).show()
    except Exception as ex:
        forms.alert(u"Could not open the shortcut window:\n{}".format(ex), title=TITLE)


def main():
    stop_running_pick()
    if ShortcutsHelper is None or KeyboardShortcutService is None:
        forms.alert("This Revit version does not offer the keyboard shortcut service.", title=TITLE)
        return
    try:
        commands = load_commands()
    except Exception as ex:
        forms.alert(u"Could not read Revit's keyboard shortcuts:\n{}".format(ex), title=TITLE)
        return
    PickSession(commands)


main()
