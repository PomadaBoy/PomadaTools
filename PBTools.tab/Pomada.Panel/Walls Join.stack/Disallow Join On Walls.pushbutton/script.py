# -*- coding: utf-8 -*-
__title__ = "Disallow Join on Walls"                                       # Name of the button displayed in Revit UI
__doc__ = """Version = 1.0
Date    = 01.07.2024
_____________________________________________________________________
Description:
On selected walls disallow join on both ends
_____________________________________________________________________
How-to: (Example)
-> Click on the button
-> Select Walls
-> Make a change
_____________________________________________________________________
Last update:
- [01.07.2024] - 1.0 RELEASE
_____________________________________________________________________
To-Do:
_____________________________________________________________________
Author: Slobodan Vesovic"""                                           # Button Description shown in Revit UI

# pyRevit EXTRA metatags: You can remove them.
__author__ = "Slobodan Vesovic"                                 # Script's Author
__min_revit_ver__ = 2019                                        # Limit your Scripts to certain Revit versions if it's not compatible due to RevitAPI Changes.

#  _   _      ___   ___   ___  _____  __  
# | | | |\/| | |_) / / \ | |_)  | |  ( (` 
# |_| |_|  | |_|   \_\_/ |_| \  |_|  _)_)  IMPORTS  
#      
# ==================================================
# Regular + Autodesk
import os
from Autodesk.Revit.DB import Transaction
#from Autodesk.Revit.DB import *                          
from Autodesk.Revit.DB import WallUtils
# pyRevit
from pyrevit import revit, forms                              
# Custom Imports



# .NET Imports
import clr                                  # Common Language Runtime. Makes .NET libraries accessinble
clr.AddReference("System")                  # Refference System.dll for import.
from System.Collections.Generic import List # List<ElementType>() <- it's special type of list from .NET framework that RevitAPI requires

#  _     __   ___  _   __   ___  _    ____ __  
# \ \  // /\ | |_)| | / /\ | |_)| |  | |_ ( (` 
#  \_\//_/--\|_| \|_|/_/--\|_|_)|_|__|_|___)_)  VARIABLES
# ========================================================
doc       = __revit__.ActiveUIDocument.Document   #type: UIDocument     # Document   class from RevitAPI that represents project. Used to Create, Delete, Modify and Query elements from the project.
uidoc     = __revit__.ActiveUIDocument            #type: Document       # UIDocument class from RevitAPI that represents Revit project opened in the Revit UI.
selection = uidoc.Selection                       #type: Selection
app       = __revit__.Application                 #type: UIApplication  # Represents the Autodesk Revit Application, providing access to documents, options and other application wide data and settings.
rvt_year  = int(app.VersionNumber)                # e.g. 2023

active_view  = doc.ActiveView
active_level = active_view.GenLevel           # Only FloorPlans are associated with a Level!
PATH_SCRIPT  = os.path.dirname(__file__)      # Absolute path to the folder where script is placed.


#  _       __    _   _     
# | |\/|  / /\  | | | |\ | 
# |_|  | /_/--\ |_| |_| \| MAIN
# ==================================================
    
with forms.WarningBar(title="Select Walls"):
    elements = revit.pick_elements()
    
    if elements is None:
        forms.alert('No elements selected. Please select elements.', exitscript=True)
        
    walls_list = []
    for element in elements:
        el_category = element.Category
        el_cat_name = el_category.Name
        
        if el_cat_name == "Walls":
            walls_list.append(element)
    
    print("Number of disjoined walls: {0}".format(len(walls_list)))
 

    
t = Transaction(doc,__title__)  


t.Start()  # <- Transaction Start

#- CHANGES TO REVIT PROJECT HERE

for wall in walls_list:
    WallUtils.DisallowWallJoinAtEnd(wall, 0)
    WallUtils.DisallowWallJoinAtEnd(wall, 1)

t.Commit()  # <- Transaction End


print('-' * 50)
print('Script is finished.')
    
    
    
 