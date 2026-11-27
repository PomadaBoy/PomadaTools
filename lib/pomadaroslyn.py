# -*- coding: utf-8 -*-
"""Compile an extension's C# assembly with pyRevit's own Roslyn, side by side.

SOFiSTiK Bridge Modeler loads Microsoft.CodeAnalysis 4.9 into Revit's default
load context. pyRevit's builder needs 4.11, and Revit can hold only one version
there, so after a sync the Reload fails with "Could not load file or assembly
'Microsoft.CodeAnalysis, Version=4.11.0.0'". This loads a second copy of the
builder and its Roslyn into a private AssemblyLoadContext and compiles the
extension into pyRevit's cache, so the next Reload just loads the finished DLL.
"""
import os

from System import Activator, AppDomain, Array, Enum, Int32, Object
from System.Collections.Generic import List

try:
    from System.Runtime.Loader import AssemblyLoadContext
except ImportError:
    # Revit 2024 and older run on .NET Framework, which has no load contexts.
    # The clash is a .NET 8 (Revit 2025+) problem, so there is nothing to fix there.
    AssemblyLoadContext = None

from pyrevit import HOST_APP
from pyrevit.userconfig import user_config

ALC_KEY = "pomada_roslyn_alc"  # kept in AppDomain data, so it lives for the whole Revit session
ROSLYN = ("Microsoft.CodeAnalysis", "Microsoft.CodeAnalysis.CSharp")
NS = "pyRevitAssemblyBuilder."


def _default_asm(name):
    for asm in AppDomain.CurrentDomain.GetAssemblies():
        ctx = AssemblyLoadContext.GetLoadContext(asm)
        if asm.GetName().Name == name and ctx is not None and ctx.Name == "Default":
            return asm
    return None


def roslyn_clash():
    """Return (loaded, needed) Roslyn versions when they differ, else None."""
    if AssemblyLoadContext is None:
        return None
    builder =_default_asm("pyRevitAssemblyBuilder")
    loaded = _default_asm("Microsoft.CodeAnalysis")
    if builder is None or loaded is None:
        return None
    needed = [r.Version for r in builder.GetReferencedAssemblies() if r.Name == "Microsoft.CodeAnalysis"]
    if not needed or loaded.GetName().Version == needed[0]:
        return None
    return str(loaded.GetName().Version), str(needed[0])


def _roslyn_dir(builder):
    """pyRevit keeps Roslyn in bin\\netcore, the builder in bin\\netcore\\engines\\<engine>."""
    folder = os.path.dirname(builder.Location)
    for _ in range(4):
        if os.path.isfile(os.path.join(folder, "Microsoft.CodeAnalysis.dll")):
            return folder
        folder = os.path.dirname(folder)
    raise IOError("pyRevit's Microsoft.CodeAnalysis.dll was not found next to " + builder.Location)


def _isolated_builder(builder):
    alc = AppDomain.CurrentDomain.GetData(ALC_KEY)
    if alc is None:
        alc = AssemblyLoadContext("pomada-roslyn", False)
        AppDomain.CurrentDomain.SetData(ALC_KEY, alc)
    have = dict((a.GetName().Name, a) for a in alc.Assemblies)
    roslyn_dir = _roslyn_dir(builder)
    for name in ROSLYN:
        if name not in have:
            have[name] = alc.LoadFromAssemblyPath(os.path.join(roslyn_dir, name + ".dll"))
    if "pyRevitAssemblyBuilder" not in have:
        have["pyRevitAssemblyBuilder"] = alc.LoadFromAssemblyPath(builder.Location)
    return have["pyRevitAssemblyBuilder"]


def prebuild(ext_names=None):
    """Compile UI extensions in the private context; None means all of them.

    An extension whose files haven't changed is a cache hit and costs nothing.
    Returns one report line per extension that was actually compiled or failed.
    """
    builder = _default_asm("pyRevitAssemblyBuilder")
    iso = _isolated_builder(builder)
    year = int(HOST_APP.version)

    log_d = Activator.CreateInstance(builder.GetType(NS + "SessionManager.LoggingHelper"))
    manager = Activator.CreateInstance(builder.GetType(NS + "SessionManager.ExtensionManagerService"),
                                       Array[Object]([Int32(year), HOST_APP.uiapp, log_d]))
    ui_exts = list(manager.GetInstalledUIExtensions())
    lib_exts = list(manager.GetInstalledLibraryExtensions())

    strategy_t = iso.GetType(NS + "AssemblyMaker.AssemblyBuildStrategy")
    log_i = Activator.CreateInstance(iso.GetType(NS + "SessionManager.LoggingHelper"))
    service = Activator.CreateInstance(iso.GetType(NS + "AssemblyMaker.AssemblyBuilderService"),
                                       Array[Object]([str(year), Enum.Parse(strategy_t, "Roslyn"), log_i]))
    rocket = bool(user_config.rocket_mode)

    cache = os.path.join(os.environ["APPDATA"], "pyRevit", str(year))
    cached = set(os.listdir(cache)) if os.path.isdir(cache) else set()

    lines = []
    for ext in ui_exts:
        if ext_names is not None and ext.Name not in ext_names:
            continue
        libs = List[ext.GetType()]()
        for lib in lib_exts:
            libs.Add(lib)
        try:
            info = service.BuildExtensionAssembly(ext, libs, rocket)
        except Exception as ex:
            lines.append("{} could not be compiled: {}".format(ext.Name, ex))
            continue
        dll = os.path.basename(str(info).split("->")[-1].strip())
        if dll not in cached:
            lines.append("{} compiled.".format(ext.Name))
    if ext_names is not None:
        missing = set(ext_names) - set(e.Name for e in ui_exts)
        if missing:
            lines.append("Not installed: " + ", ".join(sorted(missing)))
    return lines


def prebuild_if_needed(ext_names=None):
    """Prebuild only while another add-in holds a different Roslyn. Returns report lines."""
    clash = roslyn_clash()
    if clash is None:
        return []
    built = prebuild(ext_names)
    if not built:
        return []
    return ["Revit holds Roslyn {} from another add-in; pyRevit needs {}.".format(*clash)] + built
