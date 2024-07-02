# -*- coding: utf-8 -*-

#IMPORTS
from Autodesk.Revit.DB import *

#VARIABLES

app = __revit__.Application


def convert_internal_to_m(lenght):
    """Function to convert internal units to meters.
    Args:
        lenght: Lenght is internal Revit Units in Feet
    Return:
        Lenght in meters, rounded to two digitss
    """
    rvt_year = int(app.VersionNumber)
    
    #RVT < 2022
    if rvt_year < 2022:
        return UnitUtils.Convert(lenght, 
                                 DisplayUnitType.DUT_DECIMAL_FEET, 
                                 DisplayUnitType.DUT_DECIMAL_METERS) # CHANGE UNITS HERE
        
    #RVT > 2022
    else:
        return UnitUtils.ConvertFromInternalUnits(lenght, UnitTypeId.Meters)