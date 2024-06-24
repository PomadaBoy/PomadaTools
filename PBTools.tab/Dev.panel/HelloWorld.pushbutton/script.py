__title_ = "Hello BIm world"
__author__ = "Slobodan Vesovic aka. PomadaBoy"
__doc__ = """This is a heloo world program
click to see what happens"""


#Variables

uidoc = __revit__.ActiveUIDocument


#Custom import

from Snippets._selection import get_selected_elements

if __name__ == '__main__':
    print (get_selected_elements(uidoc))