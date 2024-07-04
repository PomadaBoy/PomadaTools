# -*- coding: utf-8 -*-
__title__ = "Reset Graphic Overrides"
__doc__ = """Version = 1.0
Date    = 04.07.2024
_____________________________________________________________________
Description:
This tool resets graphic overrides of selected elements.
_____________________________________________________________________
How-to: (Example)
-> Click on the button
-> Change Settings(optional)
-> Make a change
_____________________________________________________________________
Last update:
- [04.07.2024] - 1.0 RELEASE
_____________________________________________________________________
To-Do:
_____________________________________________________________________
Author: Sloodan Vesovic"""

#  _   _      ___   ___   ___  _____  __  
# | | | |\/| | |_) / / \ | |_)  | |  ( (` 
# |_| |_|  | |_|   \_\_/ |_| \  |_|  _)_)  IMPORTS  
#      
# ==================================================

from pyrevit import revit, forms
from Autodesk.Revit.DB import *

# Custom Imports
#from Snippets._context_manager import ef_Transaction

#  _     __   ___  _   __   ___  _    ____ __  
# \ \  // /\ | |_)| | / /\ | |_)| |  | |_ ( (` 
#  \_\//_/--\|_| \|_|/_/--\|_|_)|_|__|_|___)_)  VARIABLES
# ========================================================
doc     = __revit__.ActiveUIDocument.Document
uidoc   = __revit__.ActiveUIDocument
app     = __revit__.Application

#  _       __    _   _     
# | |\/|  / /\  | | | |\ | 
# |_|  | /_/--\ |_| |_| \| MAIN
# ==================================================
if __name__ == '__main__':
    # Select elements to reset overrides
    with forms.WarningBar(title="Select Elements to Reset Graphic Overrides.", handle_esc=True):
        selected_elements = revit.pick_elements()
        
    # Make sure elements are selected.
    if not selected_elements:
        forms.alert('No elements were selected. Please Try Again.', title=__title__, exitscript=True)
    
    # Start a transaction to make changes to the Revit model
    t = Transaction(doc, __title__)  # Transactions are context-like objects that guard any changes made to a Revit model.
    t.Start()  # <- Transaction Start
    
    # Reset the graphic overrides for each selected element
    for el in selected_elements:
        doc.ActiveView.SetElementOverrides(el.Id, OverrideGraphicSettings())
    
    t.Commit()  # <- Transaction End
