# -*- coding: utf-8 -*-
__title__ = "Add Levels Elevation"                                       # Name of the button displayed in Revit UI
__doc__ = """Version = 1.0
Date    = 25.6.2024
_____________________________________________________________________
Description:
Adds level elevation to level
_____________________________________________________________________
How-to: (Example)
-> Click on the button
-> Change Settings(optional)
-> Rename Levels
_____________________________________________________________________
Last update:

- [24.06.2024] - 1.0 RELEASE
_____________________________________________________________________
To-Do:

_____________________________________________________________________
Author: Slobodan Vesovic"""                                           # Button Description shown in Revit UI

# pyRevit EXTRA metatags: You can remove them.
__author__ = "Slobodan Vesovic"                                 # Script's Author
#__helpurl__ = "https://www.youtube.com/watch?v=YhL_iOKH-1M"    # Link that can be opened with F1 when hovered over the tool in Revit UI.
# __highlight__ = "new"                                         # Button will have an orange dot + Description in Revit UI
__min_revit_ver__ = 2019                                        # Limit your Scripts to certain Revit versions if it's not compatible due to RevitAPI Changes.
__max_revit_ver = 2022                                          # Limit your Scripts to certain Revit versions if it's not compatible due to RevitAPI Changes.
# __context__     = ['Walls', 'Floors', 'Roofs']                # Make your button available only when certain categories are selected. Or Revit/View Types.
# __context__     = ['Walls', 'Floors', 'Roofs']                # Make your button available only when certain categories are selected. Or Revit/View Types.
# Docs Link: https://pyrevitlabs.notion.site/Anatomy-of-IronPython-Scripts-f11d0099667f46a28d29b028dd99ccaf

#  _   _      ___   ___   ___  _____  __  
# | | | |\/| | |_) / / \ | |_)  | |  ( (` 
# |_| |_|  | |_|   \_\_/ |_| \  |_|  _)_)  IMPORTS  
#      
# ==================================================
# Regular + Autodesk
import os, sys, math, datetime, time                                    # Regular Imports
# from Autodesk.Revit.DB import Transaction, FilteredElementCollector     # or Import only classes that are used.
from Autodesk.Revit.DB.Architecture import Room, TopographySurface      # Import Discipline Specific Elements
from Autodesk.Revit.DB import *                                         # Import everything from DB (Very good for beginners)

# pyRevit
from pyrevit import revit, forms                                        # import pyRevit modules. (Lots of useful features)

# Custom Imports
from Snippets._selection import get_selected_elements                   # lib import
from Snippets._convertu import convert_internal_to_m

# .NET Imports
import clr                                  # Common Language Runtime. Makes .NET libraries accessinble
clr.AddReference("System")                  # Refference System.dll for import.
from System.Collections.Generic import List # List<ElementType>() <- it's special type of list from .NET framework that RevitAPI requires
# List_example = List[ElementId]()          # use .Add() instead of append or put python list of ElementIds in parentesis.


#  _     __   ___  _   __   ___  _    ____ __  
# \ \  // /\ | |_)| | / /\ | |_)| |  | |_ ( (` 
#  \_\//_/--\|_| \|_|/_/--\|_|_)|_|__|_|___)_)  VARIABLES
# ========================================================
doc       = __revit__.ActiveUIDocument.Document   #type: UIDocument     # Document   class from RevitAPI that represents project. Used to Create, Delete, Modify and Query elements from the project.
uidoc     = __revit__.ActiveUIDocument            #type: Document       # UIDocument class from RevitAPI that represents Revit project opened in the Revit UI.
selection = uidoc.Selection                       #type: Selection
app       = __revit__.Application                 #type: UIApplication  # Represents the Autodesk Revit Application, providing access to documents, options and other application wide data and settings.
PATH_SCRIPT  = os.path.dirname(__file__)          # Absolute path to the folder where script is placed.

rvt_year = int(app.VersionNumber)

# Symbols 

symbol_start = " ► "
symbol_end =  " ◄"
#example = "◢ +12.69 ◣"
# GLOBAL VARIABLES


#  ____  _     _      __   _____  _   ___   _      __  
# | |_  | | | | |\ | / /`   | |  | | / / \ | |\ | ( (` 
# |_|   \_\_/ |_| \| \_\_,  |_|  |_| \_\_/ |_| \| _)_) FUNCTIONS
# ===============================================================

def get_text_in_brackets(text, symbol_start, symbol_end):
    #type:(str,str,str) -> str
    """Function to get content between 2 symbols
    :param text:            Initial Text
    :param symbol_start:    Start Symbol
    :param symbol_end:      End Symbol
    :return:                Text between 2 symbols, if found.
    e.g. get_text_in_brackets('This is [not] very important message.', '[', ']') -> 'not'"""
    
    if symbol_start in text and symbol_end in text:
        start = text.find(symbol_start) + len(symbol_start)
        stop  = text.find(symbol_end)
        return text[start:stop]
    return ""

        
#  __    _      __    __   __   ____  __  
# / /`  | |    / /\  ( (` ( (` | |_  ( (` 
# \_\_, |_|__ /_/--\ _)_) _)_) |_|__ _)_)  CLASSES
# ==================================================

# - Place local classes here. If you might use any classes in other scripts, consider placing it in the lib folder.

#  _       __    _   _     
# | |\/|  / /\  | | | |\ | 
# |_|  | /_/--\ |_| |_| \| MAIN
# ==================================================
all_levels = FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Levels).WhereElementIsNotElementType().ToElements()

#Get level Elevations + convert to meters

t = Transaction(doc, __title__)
t.Start()

for lvl in all_levels:
    try:
        lvl_elevation = lvl.Elevation
        lvl_elevation_m = round(convert_internal_to_m(lvl_elevation), 2)
        lvl_elevation_m_str = "+" + str(lvl_elevation_m) if lvl_elevation > 0 else str(lvl_elevation_m)

        if symbol_start in lvl.Name and symbol_end in lvl.Name:
            current_value = get_text_in_brackets(lvl.Name, symbol_start, symbol_end)
            new_name = lvl.Name.replace(current_value, lvl_elevation_m_str)
        else:
            elevation_value = symbol_start + lvl_elevation_m_str + symbol_end
            new_name = lvl.Name + elevation_value

        current_name = lvl.Name
        lvl.Name = new_name
        print('Renamed: {} -> {}'.format(current_name, new_name))

    except Exception as e:
        print("Could not change Level's Name: {}".format(e))

t.Commit()
    
element = revit.pick_element()

