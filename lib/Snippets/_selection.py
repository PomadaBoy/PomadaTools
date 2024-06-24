# -*- coding: utf-8 -*-

# IMPORTS

from Autodesk.Revit.DB import * 
# VARIABLES

uidoc = __revit__.ActiveUIDocument
doc = __revit__.ActiveUIDocument.Document

# FUNCTIONS

def get_selected_elements(uidoc):
    """Returnes elements that are selected in Revit UI
    Args:
        uidoc (_type_): Where eleements are selected
    Return: 
        List of selected elements"""
    selected_elements = []
    
    for element_id in uidoc.Selection.GetElementIds():  
        elem = uidoc.Document.GetElement(element_id)
        selected_elements.append(elem)
        
    return selected_elements